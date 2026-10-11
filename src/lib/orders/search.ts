import type { Prisma } from "@prisma/client";
import { customerPhoneSearchKeys } from "@/lib/customers/identity";

/**
 * Shared Online-order search — ONE predicate for /commandes, the
 * confirmation queue, « À expédier » and /livraison/suivi, so an order
 * found in one list is found in all of them.
 *
 * Pure: returns Prisma conditions only. Tenant isolation is NOT done here —
 * every caller runs it through the tenant-scoped `prisma` client (tenant
 * extension + RLS), exactly like the rest of their `where`.
 *
 * Matches, case-insensitively: customer name / phone, the order's own
 * recipient snapshot (shippingName / shippingPhone), the normalized
 * `phoneKey` (partial / formatted / international phone), the external
 * store number (« #1234 » or « 1234 »), the carrier tracking number
 * (opt-in), and the order number — internal OR the per-tenant displayed one,
 * typed bare (« 140 », « 000140 ») or with the tenant's configured prefix
 * (« CMD-000140 », « BL/26-000140 ») or a legacy letters-only prefix.
 */

/** Postgres `integer` upper bound — `orderNumber` / `displayNumber` are Int columns. */
export const MAX_ORDER_NUMBER = 2_147_483_647;
/** Longer input is cut before it reaches a LIKE pattern. */
export const MAX_ORDER_SEARCH_LENGTH = 100;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The order number a user typed, or null. Accepts « 140 », « 000140 »,
 * « <prefix>-000140 » / « <prefix> 140 » / « <prefix>000140 » for the
 * tenant's configured prefix (any characters, case-insensitive), and a
 * letters-only prefix (« CMD-000140 ») for numbers shown before a prefix
 * change. Never returns a non-integer, zero, negative or out-of-range value
 * (an Int column would reject it), so it can be used in an equality filter.
 */
export function orderNumberFromQuery(
  raw: string,
  prefix?: string | null,
  /** `allowLegacyPrefix: false` — only the configured prefix (or none) is read. */
  opts: { allowLegacyPrefix?: boolean } = {}
): number | null {
  let q = raw.trim();
  if (!q || q.length > MAX_ORDER_SEARCH_LENGTH) return null;
  const p = prefix?.trim();
  // An all-digit prefix (« 26 ») would swallow the leading digits of a bare
  // all-digit number (« 2615 » → 15): such input is read as the bare number;
  // « 26-0015 » / « 26 0015 » still match the prefix.
  const digitsOnlyClash = Boolean(p && /^\d+$/.test(p) && /^\d+$/.test(q));
  const withPrefix = p && !digitsOnlyClash ? q.match(new RegExp(`^${escapeRegExp(p)}[-\\s]?(.*)$`, "i")) : null;
  if (withPrefix) {
    q = withPrefix[1];
  } else if (opts.allowLegacyPrefix !== false) {
    const legacy = q.match(/^[A-Za-z]{1,10}[-\s]?(\d.*)$/);
    if (legacy) q = legacy[1];
  }
  const m = q.match(/^0*(\d{1,10})$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_ORDER_NUMBER ? n : null;
}

export interface OrderSearchOptions {
  /** The tenant's « Préfixe des numéros de commande » (BusinessSettings.orderNumberPrefix). */
  prefix?: string | null;
  /** Also match any of the order's shipments' tracking numbers. */
  includeTrackingNumber?: boolean;
}

/** The OR-conditions for one search string; `[]` for an empty search. */
export function orderSearchConditions(raw: string, opts: OrderSearchOptions = {}): Prisma.OrderWhereInput[] {
  const q = raw.trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  if (!q) return [];
  const external = q.replace(/^#/, "").trim();
  const n = orderNumberFromQuery(q, opts.prefix);

  return [
    { customer: { fullName: { contains: q, mode: "insensitive" } } },
    { customer: { phone: { contains: q, mode: "insensitive" } } },
    // Partial / formatted / international phone on the normalized key (search only).
    ...customerPhoneSearchKeys(q).map((digits): Prisma.OrderWhereInput => ({ customer: { phoneKey: { contains: digits } } })),
    { shippingName: { contains: q, mode: "insensitive" } },
    { shippingPhone: { contains: q, mode: "insensitive" } },
    ...(external ? [{ externalNumber: { contains: external, mode: "insensitive" as const } }] : []),
    ...(opts.includeTrackingNumber
      ? [{ shipments: { some: { trackingNumber: { contains: q, mode: "insensitive" as const } } } }]
      : []),
    ...(n !== null ? [{ orderNumber: n }, { displayNumber: n }] : []),
  ];
}

/** `{ OR: [...] }` for a non-empty search, `{}` otherwise — spread into a `where`. */
export function orderSearchWhere(raw: string | null | undefined, opts: OrderSearchOptions = {}): Prisma.OrderWhereInput {
  const conditions = orderSearchConditions(raw ?? "", opts);
  return conditions.length > 0 ? { OR: conditions } : {};
}

/**
 * The order whose number the tenant actually SEES is `n`: its per-tenant
 * `displayNumber`, or — for a pre-Phase-3 row that has none — its legacy
 * `orderNumber` (same rule as displayOrderNumber). Unlike the list search
 * above, never matches a row whose hidden global `orderNumber` merely
 * happens to be `n` while it displays another number.
 */
export function visibleOrderNumberWhere(n: number): Prisma.OrderWhereInput {
  return { OR: [{ displayNumber: n }, { displayNumber: null, orderNumber: n }] };
}

/**
 * The values an EXACT identifier match compares against: as typed, UPPER and
 * lower case (same approach as the returns scan, findReturnParcels). Plain
 * `in` equality on purpose — Prisma turns `equals` + `mode: "insensitive"`
 * into an UNESCAPED `ILIKE`, so « % » / « _ » would act as wildcards and a
 * trailing « \ » makes Postgres reject the query. `[]` for an empty search.
 */
export function exactMatchCandidates(raw: string | null | undefined): string[] {
  const q = (raw ?? "").trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  return q ? [...new Set([q, q.toUpperCase(), q.toLowerCase()])] : [];
}

/**
 * Exact tracking-number ranking (see exactMatchCandidates). `null` for an
 * empty search. Pair `exact` with its complement `rest` in
 * paginateWithPriority — `rest` keeps shipments WITHOUT a tracking number
 * (SQL `NOT (NULL IN …)` is NULL, which would otherwise silently drop them
 * from the second segment).
 */
export function exactShipmentTrackingPriority(
  raw: string | null | undefined
): { exact: Prisma.ShipmentWhereInput; rest: Prisma.ShipmentWhereInput } | null {
  const candidates = exactMatchCandidates(raw);
  if (candidates.length === 0) return null;
  const exact: Prisma.ShipmentWhereInput = { trackingNumber: { in: candidates } };
  return { exact, rest: { OR: [{ trackingNumber: null }, { NOT: exact }] } };
}

/** Same ranking for an ORDER list: any of its shipments (current or past) carries the exact number. */
export function exactOrderTrackingPriority(
  raw: string | null | undefined
): { exact: Prisma.OrderWhereInput; rest: Prisma.OrderWhereInput } | null {
  const shipment = exactShipmentTrackingPriority(raw);
  if (!shipment) return null;
  return {
    exact: { shipments: { some: shipment.exact } },
    rest: { shipments: { none: shipment.exact } },
  };
}
