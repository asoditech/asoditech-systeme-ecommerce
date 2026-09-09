import "server-only";

import { prisma } from "@/lib/prisma";
import "@/lib/integrations/delivery/providers"; // populate the adapter registry
import { listDeliveryProviders } from "@/lib/integrations/delivery/registry";
import type {
  PaymentMethod,
  Prisma,
  RecordSource,
  ShipmentCostSource,
  ShipmentStatus,
} from "@prisma/client";
import { normalizeTrackingStatus, type NormalizedTrackingStatus } from "@/lib/tracking/status";
import { buildParcelContentsSummary } from "@/lib/delivery";
import { displayOrderNumber } from "@/lib/format";
import type { StoredTrackingEvent } from "@/lib/integrations/delivery/tracking-service";

/**
 * Read layer for the « Suivi » module (docs/adr/0033-tracking-module.md).
 * Reads the existing Shipment / Order / Customer / ShippingProvider rows —
 * creates nothing, duplicates no business logic. Financial fields respect
 * the caller's finance visibility (`includeCosts`).
 */

const PAGE_SIZE = 30;

export interface TrackingFilters {
  q?: string;
  status?: NormalizedTrackingStatus;
  providerId?: string;
  city?: string;
  costSource?: ShipmentCostSource;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
}

export interface TrackingRow {
  shipmentId: string;
  orderId: string;
  orderNumber: number;
  orderDisplayNumber: number | null;
  orderExternalNumber: string | null;
  orderSource: RecordSource;
  /** Pre-formatted order label (e.g. "CMD-000123" / "#22984"). */
  orderLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  customerName: string;
  customerPhone: string | null;
  city: string | null;
  productsSummary: string | null;
  orderTotal: string;
  currency: string;

  localStatus: ShipmentStatus;
  normalizedStatus: NormalizedTrackingStatus;
  providerStatusRaw: string | null;

  providerName: string;
  providerId: string;

  /** Recorded cost of THIS shipment, by ADR 0032. `null` when the caller
   * can't see costs, or the carrier gave no price ("unknown"). */
  deliveryCost: string | null;
  returnCost: string | null;
  failureCost: string | null;
  costSource: ShipmentCostSource | null;

  courierName: string | null;
  courierPhone: string | null;
  lastUpdateAt: string | null;
  lastTrackingSyncAt: string | null;
  trackingSyncError: string | null;
  deliveredAt: string | null;
  latestEvent: { label: string; location: string | null; timestamp: string | null } | null;
}

export interface TrackingDetail extends TrackingRow {
  events: StoredTrackingEvent[];
  addressLine1: string | null;
  addressLine2: string | null;
  region: string | null;
  country: string | null;
  paymentMethod: PaymentMethod;
  providerSupportsTracking: boolean;
}

/** Shared include for the list + detail queries so both map identically. */
const trackingInclude = {
  provider: {
    select: { name: true, returnCost: true, failureCost: true, providerKey: true, type: true },
  },
  order: {
    include: {
      customer: { select: { fullName: true, phone: true } },
      items: {
        select: { nameSnapshot: true, quantity: true, variation: { select: { attributes: true } } },
      },
    },
  },
} satisfies Prisma.ShipmentInclude;

type ShipmentWithRelations = Prisma.ShipmentGetPayload<{ include: typeof trackingInclude }>;

function eventsOf(raw: Prisma.JsonValue | null): StoredTrackingEvent[] {
  return Array.isArray(raw) ? (raw as unknown as StoredTrackingEvent[]) : [];
}

const money = (v: Prisma.Decimal | null | undefined): string | null => (v == null ? null : v.toString());

/** Map a normalized status to the local `ShipmentStatus` values it can come
 * from — used to translate the status filter into a DB predicate. */
const NORMALIZED_TO_LOCAL: Record<NormalizedTrackingStatus, ShipmentStatus[]> = {
  CREATED: ["EN_ATTENTE"],
  PICKUP_PENDING: ["EN_ATTENTE"],
  PICKED_UP: ["EN_TRANSIT"],
  IN_TRANSIT: ["EN_TRANSIT"],
  AT_DEPOT: ["EN_TRANSIT"],
  OUT_FOR_DELIVERY: ["EN_TRANSIT"],
  DELIVERED: ["LIVRE"],
  RETURNED: ["RETOURNE"],
  FAILED: ["ECHEC"],
  CANCELLED: ["ANNULE"],
  UNKNOWN: ["EN_ATTENTE", "EN_TRANSIT"],
};

/** Same "this is a real shipment, not a failed API-creation attempt"
 * exclusion the rest of the delivery layer uses (docs/adr/0031). */
const NOT_A_FAILED_API_ATTEMPT: Prisma.ShipmentWhereInput = {
  NOT: { status: "ECHEC", externalId: null, provider: { type: "API" } },
};

function mapRow(s: ShipmentWithRelations, includeCosts: boolean): TrackingRow {
  const events = eventsOf(s.trackingEvents);
  const last = events.length > 0 ? events[events.length - 1] : null;

  // ADR 0032: `s.cost` already holds the resolved cost, `s.costSource` says
  // which bucket it belongs to. Show it in the matching column; show the
  // provider's configured rule in the others as context.
  const isReturnCost = s.costSource === "RETURN_RULE";
  const isFailureCost = s.costSource === "FAILURE_RULE";

  return {
    shipmentId: s.id,
    orderId: s.orderId,
    orderNumber: s.order.orderNumber,
    orderDisplayNumber: s.order.displayNumber,
    orderExternalNumber: s.order.externalNumber,
    orderSource: s.order.source,
    orderLabel: displayOrderNumber({
      orderNumber: s.order.orderNumber,
      displayNumber: s.order.displayNumber,
      source: s.order.source,
      externalNumber: s.order.externalNumber,
    }),
    trackingNumber: s.trackingNumber,
    trackingUrl: s.trackingUrl,
    customerName: s.order.shippingName?.trim() || s.order.customer.fullName,
    customerPhone: s.order.shippingPhone ?? s.order.customer.phone ?? null,
    city: s.order.shippingCity,
    productsSummary: buildParcelContentsSummary(s.order.items) || null,
    orderTotal: s.order.total.toString(),
    currency: s.order.currency,

    localStatus: s.status,
    normalizedStatus: normalizeTrackingStatus(s.status, s.providerStatusRaw),
    providerStatusRaw: s.providerStatusRaw,

    providerName: s.provider.name,
    providerId: s.providerId,

    deliveryCost: includeCosts && !isReturnCost && !isFailureCost ? money(s.cost) : null,
    returnCost: includeCosts ? (isReturnCost ? money(s.cost) : money(s.provider.returnCost)) : null,
    failureCost: includeCosts ? (isFailureCost ? money(s.cost) : money(s.provider.failureCost)) : null,
    costSource: includeCosts ? s.costSource : null,

    courierName: s.courierName,
    courierPhone: s.courierPhone,
    lastUpdateAt: last?.timestamp ?? s.lastSyncedAt?.toISOString() ?? null,
    lastTrackingSyncAt: s.lastTrackingSyncAt?.toISOString() ?? null,
    trackingSyncError: s.trackingSyncError,
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    latestEvent: last
      ? { label: last.label || last.rawStatus, location: last.location, timestamp: last.timestamp }
      : null,
  };
}

export async function listTrackingRows(
  filters: TrackingFilters,
  opts: { includeCosts: boolean }
): Promise<{ rows: TrackingRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const q = filters.q?.trim();

  const where: Prisma.ShipmentWhereInput = {
    ...NOT_A_FAILED_API_ATTEMPT,
    ...(filters.providerId ? { providerId: filters.providerId } : {}),
    ...(filters.costSource ? { costSource: filters.costSource } : {}),
    ...(filters.status ? { status: { in: NORMALIZED_TO_LOCAL[filters.status] } } : {}),
    ...(filters.city
      ? { order: { is: { shippingCity: { equals: filters.city, mode: "insensitive" } } } }
      : {}),
    ...(filters.dateFrom || filters.dateTo
      ? {
          createdAt: {
            ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
            ...(filters.dateTo ? { lte: filters.dateTo } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { trackingNumber: { contains: q, mode: "insensitive" } },
            { order: { is: { customer: { is: { fullName: { contains: q, mode: "insensitive" } } } } } },
            { order: { is: { customer: { is: { phone: { contains: q, mode: "insensitive" } } } } } },
            { order: { is: { shippingName: { contains: q, mode: "insensitive" } } } },
            { order: { is: { shippingPhone: { contains: q, mode: "insensitive" } } } },
            { order: { is: { shippingCity: { contains: q, mode: "insensitive" } } } },
            { order: { is: { externalNumber: { contains: q, mode: "insensitive" } } } },
            ...(/^\d+$/.test(q) ? [{ order: { is: { orderNumber: Number(q) } } }] : []),
          ],
        }
      : {}),
  };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: trackingInclude,
    }),
    prisma.shipment.count({ where }),
  ]);

  return { rows: shipments.map((s) => mapRow(s, opts.includeCosts)), total, page, pageSize: PAGE_SIZE };
}

/** KPI counts for the header cards — from the DB, with the same "failed API
 * attempt" exclusion as the list. */
export async function getTrackingStats(): Promise<{
  total: number;
  byNormalized: Record<NormalizedTrackingStatus, number>;
}> {
  const grouped = await prisma.shipment.groupBy({
    by: ["status", "providerStatusRaw"],
    where: NOT_A_FAILED_API_ATTEMPT,
    _count: { _all: true },
  });

  const byNormalized: Record<NormalizedTrackingStatus, number> = {
    CREATED: 0,
    PICKUP_PENDING: 0,
    PICKED_UP: 0,
    IN_TRANSIT: 0,
    AT_DEPOT: 0,
    OUT_FOR_DELIVERY: 0,
    DELIVERED: 0,
    RETURNED: 0,
    FAILED: 0,
    CANCELLED: 0,
    UNKNOWN: 0,
  };
  let total = 0;
  for (const g of grouped) {
    const n = g._count._all;
    total += n;
    byNormalized[normalizeTrackingStatus(g.status, g.providerStatusRaw)] += n;
  }
  return { total, byNormalized };
}

/** Distinct destination cities that have at least one shipment (city filter). */
export async function listTrackingCities(): Promise<string[]> {
  const rows = await prisma.order.findMany({
    where: { shipments: { some: {} }, shippingCity: { not: null } },
    select: { shippingCity: true },
    distinct: ["shippingCity"],
    orderBy: { shippingCity: "asc" },
  });
  return rows.map((r) => r.shippingCity).filter((c): c is string => Boolean(c));
}

/** Providers that have at least one shipment (provider filter). */
export async function listTrackingProviders(): Promise<{ id: string; name: string }[]> {
  return prisma.shippingProvider.findMany({
    where: { shipments: { some: {} } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

export async function getTrackingDetail(
  shipmentId: string,
  opts: { includeCosts: boolean }
): Promise<TrackingDetail | null> {
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: trackingInclude,
  });
  if (!s) return null;

  const providerSupportsTracking =
    s.provider.type === "API" &&
    Boolean(s.provider.providerKey) &&
    listDeliveryProviders().some(
      (a) => a.key === s.provider.providerKey && a.capabilities.includes("FETCH_TRACKING")
    );

  return {
    ...mapRow(s, opts.includeCosts),
    events: eventsOf(s.trackingEvents),
    addressLine1: s.order.shippingAddressLine1,
    addressLine2: s.order.shippingAddressLine2,
    region: s.order.shippingRegion,
    country: s.order.shippingCountry,
    paymentMethod: s.order.paymentMethod,
    providerSupportsTracking,
  };
}
