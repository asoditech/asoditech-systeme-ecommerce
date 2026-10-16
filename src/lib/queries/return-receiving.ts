import "server-only";

import { Prisma, type ReturnReceptionStatus, type ShipmentStatus } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/session";
import { readableWarehouseIds } from "@/lib/auth/location-access";
import { displayOrderNumber } from "@/lib/format";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { MAX_ORDER_SEARCH_LENGTH, orderNumberFromQuery, orderSearchConditions, visibleOrderNumberWhere } from "@/lib/orders/search";

/**
 * P3 returns workspace (/livraison/retours) — read side.
 *
 * A parcel is a candidate ONLY when its carrier status (the local mapped
 * `Shipment.status`, src/lib/integrations/delivery/providers/*\/mapper.ts) is
 * `RETOURNE` — never ECHEC / refused / cancelled. The carrier status says the
 * parcel is on its way back; it never says it physically arrived, which is
 * exactly what a ReturnReception records. Nothing here calls a carrier.
 *
 * Tenant isolation: the tenant-scoped `prisma` client (extension + RLS).
 * Location scope: a non-global user sees only parcels whose order's ORIGINAL
 * fulfilment warehouse is one of their UserLocation rows (a legacy order with
 * no fulfilment warehouse is visible to OWNER/ADMIN only).
 */

export const RETURN_ELIGIBLE_SHIPMENT_STATUS: ShipmentStatus = "RETOURNE";

/**
 * A parcel's stage, derived from its receptions AND the order's authoritative
 * quantities (shipped − every recorded return), never from the carrier
 * status alone:
 *   A_INSPECTER    — a reception awaits inspection;
 *   INSPECTE       — inspected here at least once, none pending;
 *   A_RECEPTIONNER — never received here AND units still outstanding;
 *   DEJA_RETOURNE  — never received here but every unit is already recorded
 *                    as returned (e.g. through the order page before P3):
 *                    nothing left to receive, so never « À réceptionner ».
 */
export type ReturnParcelState = "A_RECEPTIONNER" | "A_INSPECTER" | "INSPECTE" | "DEJA_RETOURNE";

export const RETURN_PARCEL_STATE_LABELS: Record<ReturnParcelState, string> = {
  A_RECEPTIONNER: "À réceptionner",
  A_INSPECTER: "Reçu — à inspecter",
  INSPECTE: "Inspecté",
  DEJA_RETOURNE: "Déjà retourné",
};

export interface ReturnParcelView {
  shipmentId: string;
  trackingNumber: string | null;
  providerName: string;
  carrierStatus: ShipmentStatus;
  /** « Retourné » AND the order really left (shippedAt) — the only receivable parcels. */
  eligible: boolean;
  /** The order was never shipped (no stock went out): nothing physical to receive. */
  neverShipped: boolean;
  orderId: string;
  orderLabel: string;
  recipientName: string;
  recipientPhone: string | null;
  city: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  state: ReturnParcelState;
  pendingReception: { id: string; receivedAt: Date; receivedByName: string | null } | null;
  lastInspection: { id: string; inspectedAt: Date | null; inspectedByName: string | null } | null;
  inspectedCount: number;
  shippedUnits: number;
  returnedUnits: number;
  remainingUnits: number;
}

const parcelInclude = {
  provider: { select: { name: true } },
  order: {
    select: {
      id: true,
      orderNumber: true,
      displayNumber: true,
      source: true,
      externalNumber: true,
      shippingName: true,
      shippingPhone: true,
      shippingCity: true,
      fulfillmentWarehouseId: true,
      shippedAt: true,
      fulfillmentWarehouse: { select: { name: true } },
      customer: { select: { fullName: true, phone: true } },
      items: { select: { id: true, quantity: true } },
      returns: { select: { lines: { select: { orderItemId: true, quantitySellable: true, quantityDamaged: true } } } },
    },
  },
  returnReceptions: {
    orderBy: { receivedAt: "desc" },
    select: {
      id: true,
      status: true,
      receivedAt: true,
      inspectedAt: true,
      receivedBy: { select: { name: true } },
      inspectedBy: { select: { name: true } },
    },
  },
} satisfies Prisma.ShipmentInclude;

type ParcelRow = Prisma.ShipmentGetPayload<{ include: typeof parcelInclude }>;

/** Units still returnable per order item: shipped − every prior return (never below 0). */
function unitTotals(order: ParcelRow["order"]): { shipped: number; returned: number; remaining: number } {
  const returnedByItem = new Map<string, number>();
  for (const r of order.returns) {
    for (const l of r.lines) {
      if (!l.orderItemId) continue;
      returnedByItem.set(l.orderItemId, (returnedByItem.get(l.orderItemId) ?? 0) + l.quantitySellable + l.quantityDamaged);
    }
  }
  let shipped = 0;
  let returned = 0;
  let remaining = 0;
  for (const item of order.items) {
    const back = Math.min(item.quantity, returnedByItem.get(item.id) ?? 0);
    shipped += item.quantity;
    returned += back;
    remaining += item.quantity - back;
  }
  return { shipped, returned, remaining };
}

/** The stage rule — the same one awaitingReceptionShipmentIds applies in SQL. */
export function parcelState(p: { pending: boolean; inspectedCount: number; remainingUnits: number }): ReturnParcelState {
  if (p.pending) return "A_INSPECTER";
  if (p.inspectedCount > 0) return "INSPECTE";
  return p.remainingUnits > 0 ? "A_RECEPTIONNER" : "DEJA_RETOURNE";
}

function toView(row: ParcelRow, prefix: string): ReturnParcelView {
  const pending = row.returnReceptions.find((r) => r.status === "A_INSPECTER") ?? null;
  const inspected = row.returnReceptions.filter((r) => r.status === "INSPECTE");
  const totals = unitTotals(row.order);
  return {
    shipmentId: row.id,
    trackingNumber: row.trackingNumber,
    providerName: row.provider.name,
    carrierStatus: row.status,
    eligible: row.status === RETURN_ELIGIBLE_SHIPMENT_STATUS && row.order.shippedAt !== null,
    neverShipped: row.order.shippedAt === null,
    orderId: row.order.id,
    orderLabel: displayOrderNumber(row.order, prefix),
    recipientName: row.order.shippingName?.trim() || row.order.customer.fullName,
    recipientPhone: row.order.shippingPhone ?? row.order.customer.phone ?? null,
    city: row.order.shippingCity,
    warehouseId: row.order.fulfillmentWarehouseId,
    warehouseName: row.order.fulfillmentWarehouse?.name ?? null,
    state: parcelState({ pending: Boolean(pending), inspectedCount: inspected.length, remainingUnits: totals.remaining }),
    pendingReception: pending
      ? { id: pending.id, receivedAt: pending.receivedAt, receivedByName: pending.receivedBy?.name ?? null }
      : null,
    lastInspection: inspected[0]
      ? { id: inspected[0].id, inspectedAt: inspected[0].inspectedAt, inspectedByName: inspected[0].inspectedBy?.name ?? null }
      : null,
    inspectedCount: inspected.length,
    shippedUnits: totals.shipped,
    returnedUnits: totals.returned,
    remainingUnits: totals.remaining,
  };
}

/** Location read scope on the order's ORIGINAL fulfilment warehouse. */
function locationWhere(viewer: Pick<CurrentUser, "locations">): Prisma.ShipmentWhereInput {
  const ids = readableWarehouseIds(viewer);
  return ids === null ? {} : { order: { fulfillmentWarehouseId: { in: ids } } };
}

/**
 * Ids of the parcels that are truly « À réceptionner » for this viewer: an
 * eligible (RETOURNE, shipped) parcel, never received here, whose order still
 * has at least one unit not recorded as returned (sellable + damaged across
 * EVERY return of the order — the order page's included). Prisma can't
 * compare a sum against a column, hence SQL; run inside `prisma.$transaction`
 * so the tenant GUC is set first (src/lib/tenant/rls.ts), and filtered on it
 * explicitly too — correct even for a role that bypasses RLS.
 */
async function awaitingReceptionShipmentIds(viewer: Pick<CurrentUser, "locations">): Promise<string[]> {
  const ids = readableWarehouseIds(viewer);
  const location = ids === null ? Prisma.empty : Prisma.sql`AND o."fulfillmentWarehouseId" = ANY(${ids})`;
  const rows = await prisma.$transaction(
    (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT s.id
      FROM "shipments" s
      JOIN "orders" o ON o.id = s."orderId"
      WHERE s."tenantId" = current_setting('app.tenant_id', true)
        AND s.status = ${RETURN_ELIGIBLE_SHIPMENT_STATUS}::"ShipmentStatus"
        AND o."shippedAt" IS NOT NULL
        ${location}
        AND NOT EXISTS (SELECT 1 FROM "return_receptions" r WHERE r."shipmentId" = s.id)
        AND EXISTS (
          SELECT 1 FROM "order_items" oi
          WHERE oi."orderId" = o.id
            AND oi.quantity > COALESCE(
              (SELECT SUM(l."quantitySellable" + l."quantityDamaged") FROM "order_return_lines" l WHERE l."orderItemId" = oi.id),
              0
            )
        )`
  );
  return rows.map((r) => r.id);
}

function stateWhere(state: ReturnParcelState | undefined, awaitingIds: string[]): Prisma.ShipmentWhereInput {
  if (state === "A_RECEPTIONNER") return { id: { in: awaitingIds } };
  if (state === "DEJA_RETOURNE") return { AND: [{ returnReceptions: { none: {} } }, { id: { notIn: awaitingIds } }] };
  if (state === "A_INSPECTER") return { returnReceptions: { some: { status: "A_INSPECTER" } } };
  if (state === "INSPECTE") {
    return { AND: [{ returnReceptions: { some: { status: "INSPECTE" } } }, { returnReceptions: { none: { status: "A_INSPECTER" } } }] };
  }
  // « Toutes les étapes » = the workspace's work: every parcel with a
  // reception, plus those awaiting one — not the already-returned history.
  return { OR: [{ returnReceptions: { some: {} } }, { id: { in: awaitingIds } }] };
}

export const RETURN_PARCELS_PAGE_SIZE = 25;

export interface ReturnParcelFilters {
  q?: string;
  state?: ReturnParcelState;
  page?: number;
}

export async function listReturnParcels(
  viewer: Pick<CurrentUser, "locations">,
  filters: ReturnParcelFilters
): Promise<{ rows: ReturnParcelView[]; total: number; pageSize: number; counts: Record<ReturnParcelState, number> }> {
  const { orderNumberPrefix } = await getReportBusinessInfo();
  const q = filters.q?.trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  const base: Prisma.ShipmentWhereInput = {
    status: RETURN_ELIGIBLE_SHIPMENT_STATUS,
    order: { shippedAt: { not: null } },
    ...locationWhere(viewer),
  };
  const search: Prisma.ShipmentWhereInput = q
    ? {
        OR: [
          { trackingNumber: { contains: q, mode: "insensitive" } },
          ...orderSearchConditions(q, { prefix: orderNumberPrefix }).map((c): Prisma.ShipmentWhereInput => ({ order: c })),
        ],
      }
    : {};
  const awaitingIds = await awaitingReceptionShipmentIds(viewer);
  const where: Prisma.ShipmentWhereInput = { AND: [base, search, stateWhere(filters.state, awaitingIds)] };
  const page = Math.max(1, Math.trunc(filters.page ?? 1) || 1);

  const [rows, total, aInspecter, inspecte, dejaRetourne] = await Promise.all([
    prisma.shipment.findMany({
      where,
      include: parcelInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * RETURN_PARCELS_PAGE_SIZE,
      take: RETURN_PARCELS_PAGE_SIZE,
    }),
    prisma.shipment.count({ where }),
    prisma.shipment.count({ where: { AND: [base, stateWhere("A_INSPECTER", awaitingIds)] } }),
    prisma.shipment.count({ where: { AND: [base, stateWhere("INSPECTE", awaitingIds)] } }),
    prisma.shipment.count({ where: { AND: [base, stateWhere("DEJA_RETOURNE", awaitingIds)] } }),
  ]);

  return {
    rows: rows.map((r) => toView(r, orderNumberPrefix)),
    total,
    pageSize: RETURN_PARCELS_PAGE_SIZE,
    counts: { A_RECEPTIONNER: awaitingIds.length, A_INSPECTER: aInspecter, INSPECTE: inspecte, DEJA_RETOURNE: dejaRetourne },
  };
}

/**
 * Exact parcel lookup (scan / typed): the tracking number EXACTLY (as typed,
 * or upper-cased — served by the (tenantId, trackingNumber) index), else the
 * order number the tenant SEES (with or without the tenant's prefix —
 * visibleOrderNumberWhere: never a hidden global `orderNumber` that merely
 * equals the typed digits, which would hand back another order's parcel) or
 * the external store number, exactly. Returns EVERY matching shipment, eligible
 * or not, so the caller can say why a parcel can't be received; never filters
 * by location (the caller decides how to answer for a location the user lacks).
 * Tenant-scoped: another tenant's parcel is simply never found.
 */
export async function findReturnParcels(rawQuery: string, db: typeof prisma | PrismaTransactionClient = prisma): Promise<ReturnParcelView[]> {
  const q = rawQuery.trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  if (!q) return [];
  const { orderNumberPrefix } = await getReportBusinessInfo();

  const tracking = [...new Set([q, q.toUpperCase()])];
  const byTracking = await db.shipment.findMany({
    where: { trackingNumber: { in: tracking } },
    include: parcelInclude,
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  if (byTracking.length > 0) return byTracking.map((r) => toView(r, orderNumberPrefix));

  const n = orderNumberFromQuery(q, orderNumberPrefix);
  const external = q.replace(/^#/, "").trim();
  const orderConditions: Prisma.OrderWhereInput[] = [
    ...(n !== null ? [visibleOrderNumberWhere(n)] : []),
    ...(external ? [{ externalNumber: external }] : []),
  ];
  if (orderConditions.length === 0) return [];
  const byOrder = await db.shipment.findMany({
    where: { order: { OR: orderConditions } },
    include: parcelInclude,
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return byOrder.map((r) => toView(r, orderNumberPrefix));
}

export async function getReturnParcel(shipmentId: string, db: typeof prisma | PrismaTransactionClient = prisma): Promise<ReturnParcelView | null> {
  const row = await db.shipment.findUnique({ where: { id: shipmentId }, include: parcelInclude });
  if (!row) return null;
  const { orderNumberPrefix } = await getReportBusinessInfo();
  return toView(row, orderNumberPrefix);
}

// ---------------------------------------------------------------------------
// Inspection screen
// ---------------------------------------------------------------------------

export interface InspectionLineView {
  orderItemId: string;
  nameSnapshot: string;
  skuSnapshot: string;
  productId: string | null;
  variationId: string | null;
  shippedQuantity: number;
  alreadyReturned: number;
}

export interface ReceptionInspectionView {
  receptionId: string;
  status: ReturnReceptionStatus;
  receivedAt: Date;
  receivedByName: string | null;
  inspectedAt: Date | null;
  inspectedByName: string | null;
  orderReturnId: string | null;
  warehouseId: string;
  warehouseName: string;
  parcel: ReturnParcelView;
  lines: InspectionLineView[];
}

/** One reception for the inspection screen — null when it doesn't exist in
 * this tenant OR its warehouse isn't readable by the viewer (no detail leak). */
export async function getReceptionForInspection(
  receptionId: string,
  viewer: Pick<CurrentUser, "locations">
): Promise<ReceptionInspectionView | null> {
  const reception = await prisma.returnReception.findUnique({
    where: { id: receptionId },
    include: {
      warehouse: { select: { name: true } },
      receivedBy: { select: { name: true } },
      inspectedBy: { select: { name: true } },
      order: {
        select: {
          items: {
            orderBy: { id: "asc" },
            select: { id: true, nameSnapshot: true, skuSnapshot: true, productId: true, variationId: true, quantity: true },
          },
          returns: { select: { lines: { select: { orderItemId: true, quantitySellable: true, quantityDamaged: true } } } },
        },
      },
    },
  });
  if (!reception) return null;
  const ids = readableWarehouseIds(viewer);
  if (ids !== null && !ids.includes(reception.warehouseId)) return null;
  const parcel = await getReturnParcel(reception.shipmentId);
  if (!parcel) return null;

  const returnedByItem = new Map<string, number>();
  for (const r of reception.order.returns) {
    for (const l of r.lines) {
      if (l.orderItemId) returnedByItem.set(l.orderItemId, (returnedByItem.get(l.orderItemId) ?? 0) + l.quantitySellable + l.quantityDamaged);
    }
  }

  return {
    receptionId: reception.id,
    status: reception.status,
    receivedAt: reception.receivedAt,
    receivedByName: reception.receivedBy?.name ?? null,
    inspectedAt: reception.inspectedAt,
    inspectedByName: reception.inspectedBy?.name ?? null,
    orderReturnId: reception.orderReturnId,
    warehouseId: reception.warehouseId,
    warehouseName: reception.warehouse.name,
    parcel,
    lines: reception.order.items.map((i) => ({
      orderItemId: i.id,
      nameSnapshot: i.nameSnapshot,
      skuSnapshot: i.skuSnapshot,
      productId: i.productId,
      variationId: i.variationId,
      shippedQuantity: i.quantity,
      alreadyReturned: Math.min(i.quantity, returnedByItem.get(i.id) ?? 0),
    })),
  };
}
