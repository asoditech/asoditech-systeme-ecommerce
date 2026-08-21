import "server-only";

import "./providers"; // populates the production registry — see providers/index.ts
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { applyShipmentStatusTransition } from "@/lib/delivery";
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
} from "./types";
import type { Shipment, ShippingProvider, Order } from "@prisma/client";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

export class DeliveryNotConfiguredError extends Error {}
export class OrderAddressIncompleteError extends Error {}

/** Never re-thrown as a generic 500 — every branch here is a safe, French,
 * user-facing message. Anything else propagates (a real bug, not a normal
 * provider/config failure). */
export function friendlyDeliveryError(error: unknown): string {
  if (
    error instanceof DeliveryProviderError ||
    error instanceof DeliveryNotConfiguredError ||
    error instanceof OrderAddressIncompleteError
  ) {
    return error.message;
  }
  throw error;
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
 * The only path allowed to report a genuine CONNECTE state — performs one
 * real authenticated request via the adapter. Saving credentials
 * (configureDeliveryProviderApiAction) never does this on its own. See
 * docs/adr/0012-delivery-provider-integration.md.
 */
export async function testProviderConnection(providerId: string): Promise<{ status: "CONNECTE" | "ERREUR"; error?: string }> {
  const { row, adapter, credentials, config } = await loadApiProvider(providerId);

  try {
    await adapter.testConnection(credentials, config);
  } catch (error) {
    const message = friendlyDeliveryError(error);
    await prisma.shippingProvider.update({
      where: { id: row.id },
      data: { connectionStatus: "ERREUR", lastError: message, lastConnectionCheckAt: new Date() },
    });
    return { status: "ERREUR", error: message };
  }

  await prisma.shippingProvider.update({
    where: { id: row.id },
    data: {
      connectionStatus: "CONNECTE",
      lastError: null,
      lastConnectionCheckAt: new Date(),
      capabilities: [...adapter.capabilities],
    },
  });
  return { status: "CONNECTE" };
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
  const pending = await prisma.shipment.create({
    data: {
      orderId: params.order.id,
      providerId: row.id,
      status: "EN_ATTENTE",
      notes: params.notes,
      updatedById: params.updatedById,
    },
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
