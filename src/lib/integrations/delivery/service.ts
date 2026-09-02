import "server-only";

import "./providers"; // populates the production registry — see providers/index.ts
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { applyShipmentStatusTransition, SHIPPABLE_ORDER_STATUSES, ACTIVE_SHIPMENT_STATUSES } from "@/lib/delivery";
import { matchCityName } from "./city-match";
import { getDeliveryProvider, assertCapability } from "./registry";
import {
  DeliveryProviderError,
  DeliveryUnsupportedCapabilityError,
} from "./errors";
import type {
  DeliveryCredentials,
  DeliveryProviderConfig,
  DeliveryProviderAdapter,
  CreateShipmentAdapterInput,
  DeliveryManifestDocument,
} from "./types";
import type { Shipment, ShippingProvider, Order, DeliveryManifest, Prisma } from "@prisma/client";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

export class DeliveryNotConfiguredError extends Error {}
export class OrderAddressIncompleteError extends Error {}
/** Raised by generateManifestViaProvider when the selected shipments fail
 * a pre-flight check (wrong provider, not API-created, already on a
 * manifest, not awaiting handover). Carries a ready-to-show French
 * message; no local row is created. */
export class ManifestSelectionError extends Error {}
/**
 * Phase 30 hardening. Raised by reserveShipmentSlot when an ACTIVE
 * shipment already exists for (orderId, providerId) — see that function's
 * own doc comment for why a plain pre-check `findFirst` isn't enough here.
 */
export class DuplicateActiveShipmentError extends Error {}

/** Never re-thrown as a generic 500 — every branch here is a safe, French,
 * user-facing message. Anything else propagates (a real bug, not a normal
 * provider/config failure). */
export function friendlyDeliveryError(error: unknown): string {
  if (
    error instanceof DeliveryProviderError ||
    error instanceof DeliveryNotConfiguredError ||
    error instanceof OrderAddressIncompleteError ||
    error instanceof ManifestSelectionError ||
    error instanceof DuplicateActiveShipmentError
  ) {
    return error.message;
  }
  throw error;
}

/**
 * Phase 30 hardening — closes a genuine race in the shipment-creation
 * duplicate guard. Before this, both createShipmentAction and
 * createShipmentViaProvider checked for an existing ACTIVE_SHIPMENT_STATUSES
 * row with a plain `findFirst` *before* creating the new one — two
 * concurrent requests (double-click, a retried request, or a scripted
 * call) could both pass that check before either committed, so both
 * proceeded. For the API path that means two real external parcels
 * created for one order, not just a duplicate local row.
 *
 * There's no plain DB unique constraint that expresses "at most one
 * ACTIVE shipment per (orderId, providerId)" — ECHEC/ANNULE/RETOURNE rows
 * for the same pair are legitimate (a retry after a failed attempt), so a
 * full unique index on (orderId, providerId) would incorrectly block
 * that. Instead: a Postgres transaction-scoped advisory lock keyed on the
 * pair serializes concurrent callers, so the second one's check runs only
 * after the first's create has committed (and the lock auto-releases at
 * transaction end — no separate unlock call, no risk of leaking a held
 * lock on an error).
 *
 * `data` carries whatever fields the caller needs beyond orderId/providerId
 * (the manual path also sets trackingNumber/trackingUrl/cost up front; the
 * API path leaves those for the adapter response to fill in afterward).
 *
 * Returns the newly-created row or throws DuplicateActiveShipmentError.
 */
export async function reserveShipmentSlot(
  orderId: string,
  providerId: string,
  data: Pick<Prisma.ShipmentUncheckedCreateInput, "updatedById" | "notes" | "trackingNumber" | "trackingUrl" | "cost">
): Promise<Shipment> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shipment-slot:${orderId}:${providerId}`}))`;

    const existingActive = await tx.shipment.findFirst({
      where: { orderId, providerId, status: { in: ACTIVE_SHIPMENT_STATUSES } },
    });
    if (existingActive) {
      throw new DuplicateActiveShipmentError("Une expédition est déjà en cours pour cette commande auprès de ce prestataire.");
    }

    return tx.shipment.create({
      data: { orderId, providerId, ...data },
    });
  });
}

interface LoadedApiProvider {
  row: ShippingProvider;
  adapter: DeliveryProviderAdapter;
  credentials: DeliveryCredentials;
  config: DeliveryProviderConfig;
}

/**
 * Loads a ShippingProvider row, resolves its registered adapter, and
 * decrypts its credentials. Throws DeliveryNotConfiguredError (turned into
 * a friendly actionError by every caller via friendlyDeliveryError) for
 * every "not ready yet" case — never silently proceeds with partial
 * configuration.
 */
export async function loadApiProvider(providerId: string): Promise<LoadedApiProvider> {
  const row = await prisma.shippingProvider.findUnique({ where: { id: providerId } });
  if (!row) throw new DeliveryNotConfiguredError("Prestataire de livraison introuvable.");
  if (row.type !== "API") {
    throw new DeliveryNotConfiguredError("Ce prestataire n'est pas configuré comme connecteur API.");
  }
  if (!row.providerKey) {
    throw new DeliveryNotConfiguredError("Aucun connecteur n'est sélectionné pour ce prestataire.");
  }
  const adapter = getDeliveryProvider(row.providerKey);
  if (!adapter) {
    throw new DeliveryNotConfiguredError(`Le connecteur "${row.providerKey}" n'est pas disponible sur ce déploiement.`);
  }
  if (!row.credentialsEncrypted) {
    throw new DeliveryNotConfiguredError("Aucun identifiant n'est configuré pour ce prestataire.");
  }
  const credentials = JSON.parse(decryptSecret(row.credentialsEncrypted)) as DeliveryCredentials;
  const config = (row.config as DeliveryProviderConfig | null) ?? {};
  return { row, adapter, credentials, config };
}

/**
 * Best-effort enrichment of a successful connection test: if the adapter
 * can report its destination catalogue (`listCities` — "safe to call
 * during a connection test" per its own doc comment), check whether the
 * distinct shippingCity values of every order actually eligible for a
 * shipment via THIS provider right now would resolve against it —
 * eligible meaning exactly what `createShipmentViaProviderAction` itself
 * checks (SHIPPABLE_ORDER_STATUSES, no ACTIVE_SHIPMENT_STATUSES shipment
 * already on this provider), so an order whose only shipment attempt
 * failed locally (e.g. on an earlier unresolved city) is correctly
 * included as still needing one, not just orders that never had an
 * attempt. This is what makes a city-resolution problem observable
 * through the product itself — an operator sees "this order's city won't
 * resolve" the moment they test the connection, instead of discovering it
 * only when "Créer l'expédition" fails (Phase 27B —
 * docs/adr/0013-ozonexpress-integration.md). Never fatal: any failure
 * here is swallowed and simply omitted from `details` — a diagnostic that
 * can't run must never turn a real CONNECTE into ERREUR. Silent (adds
 * nothing) when every city resolves, so a healthy connector stays a
 * one-line toast, not a wall of city names.
 */
async function enrichWithCityResolutionDiagnostics(
  providerId: string,
  adapter: DeliveryProviderAdapter,
  credentials: DeliveryCredentials,
  config: DeliveryProviderConfig,
  details: Record<string, string | number> | undefined
): Promise<Record<string, string | number> | undefined> {
  if (!adapter.listCities) return details;
  try {
    const catalogue = await adapter.listCities(credentials, config);
    if (catalogue.length === 0) return details;

    const orders = await prisma.order.findMany({
      where: {
        status: { in: SHIPPABLE_ORDER_STATUSES },
        shipments: { none: { providerId, status: { in: ACTIVE_SHIPMENT_STATUSES } } },
      },
      select: { shippingCity: true },
    });
    const distinctCities = [...new Set(orders.map((o) => o.shippingCity).filter((c): c is string => !!c))];

    const unresolved: string[] = [];
    const ambiguous: string[] = [];
    for (const city of distinctCities) {
      const result = matchCityName(city, catalogue);
      if (result.outcome === "unresolved") unresolved.push(city);
      else if (result.outcome === "ambiguous") ambiguous.push(city);
    }

    const enriched = { ...details };
    if (unresolved.length > 0) enriched["villes de commandes non résolues"] = unresolved.join(", ");
    if (ambiguous.length > 0) enriched["villes de commandes ambiguës"] = ambiguous.join(", ");
    return enriched;
  } catch {
    return details;
  }
}

/**
 * The only path allowed to report a genuine CONNECTE state — performs one
 * real authenticated request via the adapter. Saving credentials
 * (configureDeliveryProviderApiAction) never does this on its own. See
 * docs/adr/0012-delivery-provider-integration.md.
 */
export async function testProviderConnection(
  providerId: string
): Promise<{ status: "CONNECTE" | "ERREUR"; error?: string; details?: Record<string, string | number> }> {
  const { row, adapter, credentials, config } = await loadApiProvider(providerId);

  let details: Record<string, string | number> | undefined;
  try {
    ({ details } = await adapter.testConnection(credentials, config));
  } catch (error) {
    const message = friendlyDeliveryError(error);
    await prisma.shippingProvider.update({
      where: { id: row.id },
      data: { connectionStatus: "ERREUR", lastError: message, lastConnectionCheckAt: new Date() },
    });
    return { status: "ERREUR", error: message };
  }

  details = await enrichWithCityResolutionDiagnostics(row.id, adapter, credentials, config, details);

  await prisma.shippingProvider.update({
    where: { id: row.id },
    data: {
      connectionStatus: "CONNECTE",
      lastError: null,
      lastConnectionCheckAt: new Date(),
      capabilities: [...adapter.capabilities],
    },
  });
  return { status: "CONNECTE", details };
}

function requireAddress(order: Order): OrderAddressIncompleteError | null {
  if (!order.shippingAddressLine1 || !order.shippingCity || !order.shippingCountry) {
    return new OrderAddressIncompleteError(
      "L'adresse de livraison de la commande est incomplète (adresse, ville et pays sont requis)."
    );
  }
  return null;
}

/**
 * Creates a shipment through a provider's API and persists the result.
 * Never marks the shipment created if the external call failed — the
 * Prisma write only happens after the adapter call has already succeeded,
 * and it writes exactly what the provider returned (never a fabricated
 * tracking number, URL, or cost). See docs/adr/0012, "Shipment creation".
 */
export async function createShipmentViaProvider(params: {
  order: Order & { customer: { fullName: string } };
  providerId: string;
  updatedById: string;
  notes: string | null;
}): Promise<Shipment> {
  const addressError = requireAddress(params.order);
  if (addressError) throw addressError;

  const { row, adapter, credentials, config } = await loadApiProvider(params.providerId);
  assertCapability(adapter, "CREATE_SHIPMENT");

  // Local-first row reserves a stable id to derive a client-side
  // idempotency key from if the adapter wants one — the row starts
  // EN_ATTENTE with no externalId and is only ever updated (never a
  // second row created) once the provider call resolves, whether it
  // succeeds or fails. This bounds duplicate-request risk to "the adapter
  // itself must dedupe retries of the same localShipmentId" rather than
  // this system creating two local rows for one retried click.
  //
  // reserveShipmentSlot (not a plain prisma.shipment.create) is what
  // actually closes the *concurrent-request* race: two callers hitting
  // this function at the same instant for the same order+provider must
  // not both reserve a slot and both call the adapter below — see that
  // function's doc comment.
  const pending = await reserveShipmentSlot(params.order.id, row.id, {
    updatedById: params.updatedById,
    notes: params.notes,
  });

  const input: CreateShipmentAdapterInput = {
    localShipmentId: pending.id,
    orderNumber: String(params.order.orderNumber),
    recipientName: params.order.customer.fullName,
    addressLine1: params.order.shippingAddressLine1!,
    addressLine2: params.order.shippingAddressLine2,
    city: params.order.shippingCity!,
    region: params.order.shippingRegion,
    country: params.order.shippingCountry!,
    phone: params.order.shippingPhone,
    codAmount: params.order.paymentMethod === "PAIEMENT_LIVRAISON" ? Number(params.order.total) : null,
    currency: params.order.currency,
    notes: params.notes,
  };

  let result;
  try {
    result = await adapter.createShipment!(input, credentials, config);
  } catch (error) {
    // The provider call failed — the shipment must not be left looking
    // like a normal pending row forever with no explanation. Mark it
    // ECHEC with a safe message rather than silently leaving EN_ATTENTE
    // (which would look identical to "not yet submitted"). This write
    // must happen even for a genuinely unexpected error (not one of the
    // typed DeliveryProviderError subclasses) — computed inline rather
    // than via friendlyDeliveryError(), which deliberately re-throws
    // unexpected errors instead of returning a message for them.
    const message = error instanceof DeliveryProviderError ? error.message : "Erreur inattendue lors de la création de l'expédition.";
    await prisma.shipment.update({
      where: { id: pending.id },
      data: { status: "ECHEC", failedReason: message },
    });
    throw error;
  }

  return prisma.shipment.update({
    where: { id: pending.id },
    data: {
      externalId: result.externalId,
      trackingNumber: result.trackingNumber,
      trackingUrl: result.trackingUrl,
      cost: result.cost,
      providerStatusRaw: result.rawStatus,
      lastSyncedAt: new Date(),
    },
  });
}

/** Cancels a provider-backed shipment: calls the carrier first, only then
 * transitions the local status — see docs/adr/0012, "Shipment creation"
 * (the same "never mark success before the external call resolves" rule
 * applies to cancellation). */
export async function cancelShipmentViaProvider(params: {
  shipment: Shipment;
  order: Order;
  updatedById: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.shipment.externalId) {
    return { ok: false, error: "Cette expédition n'a pas été créée via un connecteur API." };
  }

  const { adapter, credentials, config } = await loadApiProvider(params.shipment.providerId);
  assertCapability(adapter, "CANCEL_SHIPMENT");

  try {
    await adapter.cancelShipment!({ externalId: params.shipment.externalId }, credentials, config);
  } catch (error) {
    return { ok: false, error: friendlyDeliveryError(error) };
  }

  const result = await applyShipmentStatusTransition({
    shipmentId: params.shipment.id,
    currentStatus: params.shipment.status as ShipmentStatusValue,
    orderId: params.order.id,
    currentOrderStatus: params.order.status,
    newStatus: "ANNULE",
    updatedById: params.updatedById,
  });
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "invalid_transition"
          ? "Le transporteur a confirmé l'annulation, mais le statut local ne permet plus cette transition."
          : "Cette expédition a été modifiée entre-temps. Rechargez la page et réessayez.",
    };
  }
  return { ok: true };
}

export type SyncShipmentStatusOutcome =
  | { outcome: "updated"; newStatus: ShipmentStatusValue }
  | { outcome: "unchanged" }
  | { outcome: "unknown_status"; rawStatus: string }
  | { outcome: "error"; error: string };

/**
 * Manual, per-shipment "Synchroniser le statut" action — the polling half
 * of status synchronization (no live webhook route exists yet; see
 * docs/adr/0012, "Webhooks / polling"). Also the function a future webhook
 * route would call after verifying a delivery, per the recommended
 * "webhook -> trigger -> authoritative fetch -> shared update pipeline"
 * pattern, so there is exactly one status-mapping/update code path.
 */
export async function syncShipmentStatus(params: {
  shipment: Shipment;
  order: Order;
  updatedById: string | null;
}): Promise<SyncShipmentStatusOutcome> {
  if (!params.shipment.externalId) {
    return { outcome: "error", error: "Cette expédition n'a pas été créée via un connecteur API." };
  }

  let adapter, credentials, config;
  try {
    ({ adapter, credentials, config } = await loadApiProvider(params.shipment.providerId));
    assertCapability(adapter, "FETCH_STATUS");
  } catch (error) {
    return { outcome: "error", error: friendlyDeliveryError(error) };
  }

  let fetched;
  try {
    fetched = await adapter.fetchStatus!({ externalId: params.shipment.externalId }, credentials, config);
  } catch (error) {
    return { outcome: "error", error: friendlyDeliveryError(error) };
  }

  const mapped = adapter.mapStatus?.(fetched.rawStatus) ?? null;

  const extraData = {
    providerStatusRaw: fetched.rawStatus,
    lastSyncedAt: new Date(),
    ...(fetched.trackingUrl ? { trackingUrl: fetched.trackingUrl } : {}),
    ...(fetched.cost !== null ? { cost: fetched.cost } : {}),
  };

  if (!mapped) {
    // Never guessed — recorded as provider metadata and reported, per
    // docs/adr/0012, "Status synchronization".
    await prisma.shipment.update({ where: { id: params.shipment.id }, data: extraData });
    return { outcome: "unknown_status", rawStatus: fetched.rawStatus };
  }

  if (mapped === params.shipment.status) {
    // Idempotent: still record the fresh raw status/sync time, but no
    // status transition (and therefore no order side effect) happens.
    await prisma.shipment.update({ where: { id: params.shipment.id }, data: extraData });
    return { outcome: "unchanged" };
  }

  const result = await applyShipmentStatusTransition({
    shipmentId: params.shipment.id,
    currentStatus: params.shipment.status as ShipmentStatusValue,
    orderId: params.order.id,
    currentOrderStatus: params.order.status,
    newStatus: mapped,
    updatedById: params.updatedById,
    extraData,
  });
  if (!result.ok) {
    // The provider reports a status our own transition table doesn't
    // allow from the current local status (e.g. staff already moved the
    // shipment on manually) — still persist the raw status/sync time so
    // it's visible, but don't force an invalid transition.
    await prisma.shipment.update({ where: { id: params.shipment.id }, data: extraData });
    return {
      outcome: "error",
      error:
        result.reason === "conflict"
          ? "Cette expédition a été modifiée entre-temps."
          : `Le transporteur signale un statut ("${fetched.rawStatus}") qui n'est pas une transition valide depuis l'état local actuel.`,
    };
  }
  return { outcome: "updated", newStatus: mapped };
}

// ---------------------------------------------------------------------------
// Delivery manifest (Bon de Livraison) — see docs/adr/0015-delivery-manifest.md
// ---------------------------------------------------------------------------

/**
 * Shipment statuses a parcel can be on a fresh manifest in: only
 * EN_ATTENTE — i.e. registered with the carrier but not yet handed over.
 * Once EN_TRANSIT the carrier already has the parcel; a terminal status
 * means it is done. Putting either on a new handover document is a
 * mistake, so the selection is rejected rather than silently filtered.
 */
const MANIFESTABLE_SHIPMENT_STATUSES = new Set<ShipmentStatusValue>(["EN_ATTENTE"]);

/** Sanitises the adapter's document list for the `documents` JSON column:
 * only well-formed `{ label, https-url }` entries survive (the value is
 * rendered as `<a href>` on the Livraison page, and the adapter contract
 * already requires https, but this column is a JSON blob). */
function documentsToJson(documents: DeliveryManifestDocument[]): { label: string; url: string }[] {
  const clean: { label: string; url: string }[] = [];
  for (const d of documents) {
    if (typeof d?.label !== "string" || typeof d?.url !== "string") continue;
    try {
      if (new URL(d.url).protocol === "https:") clean.push({ label: d.label, url: d.url });
    } catch {
      // skip malformed url
    }
  }
  return clean;
}

/**
 * Groups the given local shipments into one carrier delivery note /
 * manifest via the provider's `generateManifest` adapter method.
 *
 * Pre-flight (all-or-nothing, before any local row or network call): every
 * shipment must exist, belong to `providerId`, be API-created
 * (`externalId` set), not already be on a manifest, and be EN_ATTENTE.
 * Any failure raises `ManifestSelectionError` with a French message —
 * nothing is written.
 *
 * Then: a local `DeliveryManifest` (BROUILLON) is created, the adapter is
 * called, and on success the manifest is finalised (`externalRef`,
 * `parcelCount`, `documents`, status FINALISE) and every shipment is
 * linked to it — atomically. On adapter failure the manifest is marked
 * ECHEC with a safe reason and no shipment is linked; the typed error
 * propagates.
 */
export async function generateManifestViaProvider(params: {
  providerId: string;
  shipmentIds: string[];
  createdById: string;
}): Promise<DeliveryManifest> {
  const uniqueIds = [...new Set(params.shipmentIds)];
  if (uniqueIds.length === 0) {
    throw new ManifestSelectionError("Sélectionnez au moins une expédition.");
  }

  const { row, adapter, credentials, config } = await loadApiProvider(params.providerId);
  assertCapability(adapter, "GENERATE_MANIFEST");

  const shipments = await prisma.shipment.findMany({ where: { id: { in: uniqueIds } } });
  if (shipments.length !== uniqueIds.length) {
    throw new ManifestSelectionError("Une ou plusieurs expéditions sélectionnées sont introuvables.");
  }
  const problems: string[] = [];
  for (const s of shipments) {
    if (s.providerId !== row.id) problems.push("rattachées à un autre prestataire");
    else if (!s.externalId) problems.push("créées manuellement (sans connecteur)");
    else if (s.manifestId) problems.push("déjà sur un bon de livraison");
    else if (!MANIFESTABLE_SHIPMENT_STATUSES.has(s.status as ShipmentStatusValue))
      problems.push("qui ne sont plus en attente de remise au transporteur");
  }
  if (problems.length > 0) {
    throw new ManifestSelectionError(
      `Impossible de créer le bon de livraison : certaines expéditions sont ${[...new Set(problems)].join(", ")}.`
    );
  }

  const manifest = await prisma.deliveryManifest.create({
    data: {
      providerId: row.id,
      status: "BROUILLON",
      parcelCount: shipments.length,
      createdById: params.createdById,
    },
  });

  let result;
  try {
    result = await adapter.generateManifest!(
      { externalIds: shipments.map((s) => s.externalId!) },
      credentials,
      config
    );
  } catch (error) {
    const message =
      error instanceof DeliveryProviderError
        ? error.message
        : "Erreur inattendue lors de la création du bon de livraison.";
    await prisma.deliveryManifest.update({
      where: { id: manifest.id },
      data: { status: "ECHEC", failedReason: message },
    });
    throw error;
  }

  const documents = documentsToJson(result.documents) as Prisma.InputJsonValue;
  return prisma.$transaction(async (tx) => {
    const finalised = await tx.deliveryManifest.update({
      where: { id: manifest.id },
      data: {
        status: "FINALISE",
        externalRef: result.externalRef,
        parcelCount: result.parcelCount ?? shipments.length,
        documents,
        failedReason: null,
      },
    });
    // Only link shipments still EN_ATTENTE and still unmanifested — guards
    // the (narrow) window where another action moved one on between the
    // pre-flight read and here. A shipment the carrier put on the manifest
    // but that we couldn't link is still visible via the manifest's ref.
    await tx.shipment.updateMany({
      where: { id: { in: shipments.map((s) => s.id) }, manifestId: null, status: "EN_ATTENTE" },
      data: { manifestId: manifest.id },
    });
    return finalised;
  });
}

export type DeliveryWebhookOutcome =
  | { outcome: "processed"; result: SyncShipmentStatusOutcome }
  | { outcome: "already_processed" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "rejected"; reason: string };

/**
 * Verifies and processes one inbound provider webhook delivery. Not wired
 * to a live HTTP route in this phase (no real provider is registered to
 * send anything) — built and unit-tested now so a real provider's route
 * handler is a thin wrapper around this function (raw body + headers in,
 * typed outcome out), per docs/adr/0012, "Webhooks / polling". Follows the
 * "webhook -> trigger -> authoritative fetch -> shared update pipeline"
 * pattern: the payload is only used to identify *which* shipment changed
 * and to pick the signature secret; the actual status update reuses
 * syncShipmentStatus's authoritative fetch, exactly like
 * docs/adr/0010-woocommerce-integration.md's webhook -> import-logic reuse.
 */
export async function handleDeliveryWebhook(params: {
  providerId: string;
  rawBody: string;
  headers: Record<string, string>;
  deliveryIdHeader: string | null;
}): Promise<DeliveryWebhookOutcome> {
  const row = await prisma.shippingProvider.findUnique({ where: { id: params.providerId } });
  if (!row || row.type !== "API" || !row.providerKey) {
    return { outcome: "rejected", reason: "Prestataire introuvable ou non configuré en connecteur API." };
  }
  const adapter = getDeliveryProvider(row.providerKey);
  if (!adapter) {
    return { outcome: "rejected", reason: "Connecteur non disponible." };
  }
  try {
    assertCapability(adapter, "WEBHOOKS");
  } catch (error) {
    if (error instanceof DeliveryUnsupportedCapabilityError) {
      return { outcome: "rejected", reason: error.message };
    }
    throw error;
  }
  if (!row.credentialsEncrypted) {
    return { outcome: "rejected", reason: "Aucun identifiant configuré." };
  }
  const credentials = JSON.parse(decryptSecret(row.credentialsEncrypted)) as DeliveryCredentials & {
    webhookSecret?: string;
  };
  if (!credentials.webhookSecret) {
    return { outcome: "rejected", reason: "Aucun secret de webhook configuré." };
  }

  const verified = adapter.verifyWebhookSignature!(params.rawBody, params.headers, credentials.webhookSecret);
  if (!verified) {
    return { outcome: "rejected", reason: "Signature invalide." };
  }

  const event = adapter.mapWebhookPayload!(params.rawBody, params.headers);
  if (!event) {
    return { outcome: "ignored", reason: "Type d'évènement non pris en charge." };
  }

  const deliveryId = params.deliveryIdHeader ?? event.deliveryId;
  try {
    await prisma.shipmentWebhookEvent.create({
      data: { providerId: row.id, deliveryId, topic: event.topic, resourceId: event.externalId, status: "TRAITE" },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // A concurrent delivery of the same event, or a true replay of an
      // already-processed one — see shared/webhook-event.ts's identical
      // reasoning (docs/adr/0011's Phase 21 addendum).
      return { outcome: "already_processed" };
    }
    throw error;
  }

  if (!event.externalId) {
    return { outcome: "ignored", reason: "Évènement sans identifiant d'expédition." };
  }

  const shipment = await prisma.shipment.findFirst({
    where: { providerId: row.id, externalId: event.externalId },
    include: { order: true },
  });
  if (!shipment) {
    return { outcome: "ignored", reason: "Expédition locale correspondante introuvable." };
  }

  const result = await syncShipmentStatus({ shipment, order: shipment.order, updatedById: null });
  return { outcome: "processed", result };
}
