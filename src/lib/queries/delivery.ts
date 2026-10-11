import "server-only";

import { prisma } from "@/lib/prisma";
import "@/lib/integrations/delivery/providers"; // populates the registry — see that module's own doc comment
import { listDeliveryProviders, getDeliveryProvider } from "@/lib/integrations/delivery/registry";
import { ACTIVE_SHIPMENT_STATUSES, deliveryOutcomeRate } from "@/lib/delivery";
import { shippableOrderWhere } from "@/lib/packing";
import { isPackingRequired } from "@/lib/packing-settings";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import {
  MAX_ORDER_SEARCH_LENGTH,
  exactOrderTrackingPriority,
  exactShipmentTrackingPriority,
  orderSearchConditions,
  orderSearchWhere,
} from "@/lib/orders/search";
import { paginateWithPriority } from "@/lib/priority-pagination";
import { countOutcomes, orderDeliveryOutcome } from "@/lib/metrics/formulas";
import type { Prisma, ShipmentStatus, ShippingProviderType } from "@prisma/client";

const PAGE_SIZE = 30;

/**
 * The capabilities to gate a generic UI affordance on (Batch 18 — "Delivery
 * Provider UX Decoupling"): show a control (city mapping, cancellation, …)
 * only for a capability the carrier genuinely supports.
 *
 * Deliberately reads the **live adapter registry**, not
 * `ShippingProvider.capabilities` — that DB column is only snapshotted on a
 * successful `testDeliveryProviderConnectionAction` (docs/adr/0012), so
 * using it here would conflate "connected" with "supports this capability"
 * (exactly the three-way distinction docs/adr/0018/0028 call out: provider
 * configured vs. connected vs. supports X). A provider that is only
 * CONFIGURE (never yet tested, or whose last test happened to fail) still
 * genuinely supports whatever its adapter declares — e.g. a shipment
 * creation attempt can fail with a city error before the operator has ever
 * run "Tester la connexion" (the server doesn't require CONNECTE to try),
 * and the fix-it affordance must still show up then.
 */
export function providerCapabilities(provider: { type: ShippingProviderType; providerKey: string | null }): string[] {
  if (provider.type !== "API" || !provider.providerKey) return [];
  return [...(getDeliveryProvider(provider.providerKey)?.capabilities ?? [])];
}

export async function listShippingProviders() {
  return prisma.shippingProvider.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { shipments: true } } } });
}

/**
 * Narrow, client-safe provider list (no credentials / raw config) — for
 * the shipment dialogs on the order detail page. Same shape as
 * `ShipmentProviderOption`. `capabilities` (the live adapter's, via
 * `providerCapabilities` — not the DB snapshot) is included so the generic
 * UI can show only the actions this provider instance genuinely supports
 * (Batch 18 — see e.g. FETCH_CITIES gating on the "Corriger la ville"
 * affordance) instead of assuming every API provider supports the same set.
 */
export async function listShipmentProviderOptions() {
  const providers = await prisma.shippingProvider.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, type: true, connectionStatus: true, providerKey: true },
  });
  return providers.map(({ providerKey, ...rest }) => ({
    ...rest,
    capabilities: providerCapabilities({ type: rest.type, providerKey }),
  }));
}

/**
 * The tenant's active providers, narrowed to just what
 * `cityGuidanceFromProviders` (docs/adr/0018 — Group 2 of the post-audit UX
 * fixes) needs to de-hardcode the "match the carrier's city exactly"
 * warning that generic order UI shows. Same `isActive` scope as
 * `listShipmentProviderOptions` above.
 */
export async function listActiveProvidersForCityGuidance() {
  return prisma.shippingProvider.findMany({
    where: { isActive: true },
    select: { name: true, capabilities: true },
  });
}

/**
 * Shipments REPLACED by a newer attempt on the same order — history, not
 * work (an « Annulé » or failed parcel followed by a re-shipment). An order
 * has at most one active parcel (reserveShipmentSlot), so the newest
 * shipment of an order is its current one; a failed API creation attempt
 * (never a real parcel, hidden from every list) never replaces anything.
 * Raw SQL (a row compared with its siblings) inside `prisma.$transaction`
 * so the tenant GUC is set, and filtered on it explicitly too.
 */
export async function listSupersededShipments(): Promise<{ id: string; orderId: string }[]> {
  return prisma.$transaction(
    (tx) => tx.$queryRaw<{ id: string; orderId: string }[]>`
      SELECT s.id, s."orderId"
      FROM "shipments" s
      WHERE s."tenantId" = current_setting('app.tenant_id', true)
        AND EXISTS (
          SELECT 1
          FROM "shipments" n
          JOIN "shipping_providers" p ON p.id = n."providerId"
          WHERE n."orderId" = s."orderId"
            AND (n."createdAt" > s."createdAt" OR (n."createdAt" = s."createdAt" AND n.id > s.id))
            AND NOT (n.status = 'ECHEC'::"ShipmentStatus" AND n."externalId" IS NULL AND p.type = 'API'::"ShippingProviderType")
        )`
  );
}

/** Ids to leave out of « current » views, and how many earlier attempts each order has. */
function shipmentHistoryIndex(superseded: { id: string; orderId: string }[]) {
  const previousAttemptsByOrder: Record<string, number> = {};
  for (const s of superseded) previousAttemptsByOrder[s.orderId] = (previousAttemptsByOrder[s.orderId] ?? 0) + 1;
  return { supersededIds: superseded.map((s) => s.id), previousAttemptsByOrder };
}

export async function listShipments(params: {
  status?: ShipmentStatus;
  providerId?: string;
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  /** Rows per page — /livraison passes the URL's 10/50/100; default 30. */
  pageSize?: number;
  /** The tenant's order-number prefix, when the caller already has it (avoids a second read). */
  orderNumberPrefix?: string | null;
  /** true = every attempt, replaced ones included (« Afficher l'historique »);
   * default = one row per order, its current shipment (a search always
   * covers every attempt). */
  history?: boolean;
}) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : PAGE_SIZE;
  const q = params.search?.trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  const orderPrefix = q
    ? params.orderNumberPrefix !== undefined
      ? params.orderNumberPrefix
      : (await getReportBusinessInfo()).orderNumberPrefix
    : null;
  const { supersededIds, previousAttemptsByOrder } = shipmentHistoryIndex(await listSupersededShipments());
  const where: Prisma.ShipmentWhereInput = {
    // An API-provider shipment that never got created at the carrier
    // (ECHEC + no externalId) is a failed *attempt*, not a shipment — it
    // clutters the list, and the order is already back in « À expédier »
    // (where the failure reason + fix actions live). A MANUEL provider's
    // ECHEC is a real, deliberately-set failure and is kept.
    NOT: { status: "ECHEC", externalId: null, provider: { type: "API" } },
    // One row per order (its current shipment) unless the history is asked
    // for — or a search is typed: an old parcel's tracking number must still
    // be found (it then shows « Remplacée »).
    ...(params.history || q || supersededIds.length === 0 ? {} : { id: { notIn: supersededIds } }),
    ...(params.status ? { status: params.status } : {}),
    ...(params.providerId ? { providerId: params.providerId } : {}),
    // This shipment's own tracking number + the shared order search
    // (src/lib/orders/search.ts) — same pattern as Suivi (listTrackingRows).
    ...(q
      ? {
          OR: [
            { trackingNumber: { contains: q, mode: "insensitive" } },
            ...orderSearchConditions(q, { prefix: orderPrefix }).map(
              (condition): Prisma.ShipmentWhereInput => ({ order: { is: condition } })
            ),
          ],
        }
      : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          createdAt: {
            ...(params.dateFrom ? { gte: params.dateFrom } : {}),
            ...(params.dateTo ? { lte: params.dateTo } : {}),
          },
        }
      : {}),
  };

  // An exact tracking-number match ranks first, across pages; newest first
  // inside each segment (id as a stable tie-break).
  const { rows: shipments, total } = await paginateWithPriority({
    where,
    priority: exactShipmentTrackingPriority(q),
    skip: (page - 1) * pageSize,
    take: pageSize,
    and: (a, b): Prisma.ShipmentWhereInput => ({ AND: [a, b] }),
    count: (w) => prisma.shipment.count({ where: w }),
    findMany: (w, skip, take) =>
      prisma.shipment.findMany({
        where: w,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
        include: { order: { include: { customer: true } }, provider: true },
      }),
  });

  return {
    shipments,
    total,
    page,
    pageSize,
    /** orderId → number of earlier (replaced) attempts — the « N tentatives » badge. */
    previousAttemptsByOrder,
    /** Replaced shipments on this page (history view) — labelled « Remplacée ». */
    supersededIds: shipments.filter((s) => supersededIds.includes(s.id)).map((s) => s.id),
  };
}

/**
 * Delivery KPIs per ORDER (its current shipment — a replaced attempt is
 * history and never counted twice), shipments created in the range. The
 * rate is the final-outcome rate: delivered ÷ (delivered + failed +
 * returned); parcels still on their way and cancelled ones have no
 * delivery outcome and stay out of it (docs/analytics/metric-definitions.md).
 */
export async function getDeliveryStats(dateFrom?: Date, dateTo?: Date) {
  const { supersededIds } = shipmentHistoryIndex(await listSupersededShipments());
  const dateFilter: Prisma.ShipmentWhereInput = {
    // Exclude failed creation attempts (see listShipments) — they are not
    // real shipments and must not inflate "Échecs" or drag down the
    // success rate.
    NOT: { status: "ECHEC", externalId: null, provider: { type: "API" } },
    ...(supersededIds.length > 0 ? { id: { notIn: supersededIds } } : {}),
    ...(dateFrom || dateTo
      ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
      : {}),
  };

  // Each current shipment is classified with its ORDER's status through the
  // one shared rule (orderDeliveryOutcome): a Retour / Remboursée recorded
  // on the order wins over the parcel's « Livré » — the same numbers as
  // /rapports/livraison (src/lib/queries/reports/delivery.ts).
  const rows = await prisma.shipment.findMany({
    where: dateFilter,
    select: { status: true, order: { select: { status: true } } },
  });
  const { delivered, failed, returned } = countOutcomes(
    rows.map((s) => orderDeliveryOutcome(s.order?.status ?? "EXPEDIEE", s.status)),
  );
  const total = rows.length;
  const inTransit = rows.filter((s) => s.status === "EN_TRANSIT").length;
  return {
    total,
    delivered,
    failed,
    returned,
    inTransit,
    successRate: deliveryOutcomeRate({ delivered, failed, returned }),
  };
}

/**
 * API-created shipments still EN_ATTENTE and not yet on a delivery note —
 * the candidates for a new Bon de Livraison. See
 * docs/adr/0015-delivery-manifest.md.
 */
export async function listManifestableShipments() {
  return prisma.shipment.findMany({
    where: {
      status: "EN_ATTENTE",
      manifestId: null,
      externalId: { not: null },
      provider: { type: "API" },
    },
    include: { order: { include: { customer: true } }, provider: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Delivery notes / manifests, newest first, with their provider + parcel count. */
export async function listDeliveryManifests() {
  return prisma.deliveryManifest.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { provider: true, _count: { select: { shipments: true } } },
  });
}

/**
 * Orders that still need a shipment created — i.e. exactly the orders
 * `createShipmentAction`/`createShipmentViaProviderAction` would accept
 * right now. Deliberately not "no shipment row at all": an order whose
 * only shipment attempt already failed (status ECHEC — no external
 * parcel, e.g. from an unresolved delivery-provider city) still needs
 * one, and must keep showing up here for the operator to retry — see
 * docs/adr/0013-ozonexpress-integration.md (Phase 27B fix; this powers
 * the "À expédier" tab). Only a genuinely live shipment
 * (ACTIVE_SHIPMENT_STATUSES) with any provider excludes an order.
 */
export async function listOrdersAwaitingShipment(
  params: { page?: number; search?: string; /** Rows per page (default 30). */ pageSize?: number } = {}
) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : PAGE_SIZE;
  const search = params.search?.trim();

  // Order eligibility (incl. « Vérification de l'emballage obligatoire ») is
  // the same rule every shipment-creation action enforces — src/lib/packing.ts.
  const where: Prisma.OrderWhereInput = {
    ...shippableOrderWhere(await isPackingRequired()),
    shipments: { none: { status: { in: ACTIVE_SHIPMENT_STATUSES } } },
    // Shared search (src/lib/orders/search.ts). These orders have no active
    // shipment; a failed attempt's tracking number is still matched.
    ...(search
      ? orderSearchWhere(search, { prefix: (await getReportBusinessInfo()).orderNumberPrefix, includeTrackingNumber: true })
      : {}),
  };

  // An order with a shipment whose tracking number EXACTLY matches ranks first.
  const { rows: orders, total } = await paginateWithPriority({
    where,
    priority: exactOrderTrackingPriority(search),
    skip: (page - 1) * pageSize,
    take: pageSize,
    and: (a, b): Prisma.OrderWhereInput => ({ AND: [a, b] }),
    count: (w) => prisma.order.count({ where: w }),
    findMany: (w, skip, take) =>
      prisma.order.findMany({
        where: w,
        include: {
          customer: true,
          items: { select: { nameSnapshot: true, quantity: true, variation: { select: { attributes: true } } } },
          // Most recent failed creation attempt, if any — surfaced in the
          // « À expédier » row so the operator can fix the city/address and
          // retry without hunting through the shipments list.
          shipments: {
            where: { status: "ECHEC", externalId: null },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { failedReason: true },
          },
        },
        // Newest first — a freshly confirmed order must appear at the top,
        // not fall off the end of the list behind a backlog of imported
        // orders. `placedAt` for consistency with the rest of the app
        // (id: stable tie-break across pages).
        orderBy: [{ placedAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
  });

  return { orders, total, page, pageSize };
}

/**
 * Serializable summary of the delivery-provider adapters actually
 * registered on this deployment (never the full adapter object, which
 * carries functions and can't cross the Server -> Client boundary — see
 * docs/adr/0012-delivery-provider-integration.md). Populated from
 * src/lib/integrations/delivery/providers/index.ts (currently: OzonExpress).
 */
export interface AvailableDeliveryConnector {
  key: string;
  displayName: string;
  capabilities: string[];
  /** Typed credential inputs for the "Configurer" form. Empty → the raw
   * JSON credential editor is shown instead. */
  credentialFields: { name: string; label: string; type: "text" | "password"; required: boolean; help?: string }[];
}

export function listAvailableDeliveryConnectors(): AvailableDeliveryConnector[] {
  return listDeliveryProviders().map((adapter) => ({
    key: adapter.key,
    displayName: adapter.displayName,
    capabilities: [...adapter.capabilities],
    credentialFields: adapter.credentialFields ? adapter.credentialFields.map((f) => ({ ...f })) : [],
  }));
}
