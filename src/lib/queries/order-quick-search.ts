import "server-only";

import type { Prisma, ShipmentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  MAX_ORDER_SEARCH_LENGTH,
  exactMatchCandidates,
  orderNumberFromQuery,
  visibleOrderNumberWhere,
} from "@/lib/orders/search";

/**
 * Command-palette ORDER lookup (src/actions/search.ts). Identifiers only —
 * the palette's own customer section already finds people by name / phone,
 * so matching them here too would only duplicate rows.
 *
 * Ranked, each stage bounded by what's left of the limit:
 *   1. a shipment (current or past) whose tracking number EXACTLY matches;
 *   2. the order number the tenant SEES (displayNumber, or the legacy number
 *      of a pre-Phase-3 row — never a hidden global orderNumber that merely
 *      equals the typed digits), or the external store number, exactly;
 *   3. a visible order number that STARTS WITH the typed digits (« 14 » →
 *      14, 140–149, 1400–1499…; « CMD-0001 » → the padded « 0001xx »), as
 *      index-friendly integer ranges on (tenantId, displayNumber);
 *   4. a shipment whose tracking number CONTAINS the text (≥ 4 characters).
 * Tenant-scoped by the `prisma` client (tenant extension + RLS).
 */

export const QUICK_SEARCH_ORDER_LIMIT = 5;
const MIN_PARTIAL_TRACKING_LENGTH = 4;
/** The prefix every tenant had before « Préfixe des numéros de commande » existed. */
const DEFAULT_ORDER_PREFIX = "CMD";

/**
 * The visible order number typed in the palette, or null. Stricter than the
 * list search: only the tenant's configured prefix (or the original « CMD »)
 * is read — never any letters-then-digits text (« OZ123456 », « Article 12 »)
 * — and a bare run of 9+ digits is a phone or tracking number, not an order
 * number anyone reads off a screen.
 */
export function quickSearchOrderNumber(raw: string, prefix?: string | null): number | null {
  const q = raw.trim();
  if (/^\d{9,}$/.test(q)) return null;
  const strict = { allowLegacyPrefix: false };
  const configured = orderNumberFromQuery(q, prefix, strict);
  if (configured !== null) return configured;
  if ((prefix?.trim() ?? "").toUpperCase() === DEFAULT_ORDER_PREFIX) return null;
  return orderNumberFromQuery(q, DEFAULT_ORDER_PREFIX, strict);
}

/** Width of the zero-padded number shown on screen (formatOrderNumber: « CMD-000140 »). */
const DISPLAY_PAD = 6;

/**
 * The integer ranges whose numbers, as SHOWN, start with `digits`:
 *   - without a leading zero, the plain number starts with them
 *     (« 14 » → [14,14], [140,149], [1400,1499], … up to the Int max);
 *   - with a leading zero, the 6-digit padded form does
 *     (« 0001 » → [100,199]; « 000140 » → [140,140]).
 * `[]` when nothing can match. Pure; each range is a btree range scan.
 */
export function orderNumberPrefixRanges(digits: string, maxNumber = 2_147_483_647): { gte: number; lte: number }[] {
  if (!/^\d{1,10}$/.test(digits)) return [];
  if (digits.startsWith("0")) {
    if (digits.length > DISPLAY_PAD) return [];
    const scale = 10 ** (DISPLAY_PAD - digits.length);
    const gte = Math.max(1, Number(digits) * scale);
    const lte = Math.min(maxNumber, (Number(digits) + 1) * scale - 1);
    return gte <= lte ? [{ gte, lte }] : [];
  }
  const ranges: { gte: number; lte: number }[] = [];
  const base = Number(digits);
  for (let extra = 0; digits.length + extra <= 10; extra++) {
    const scale = 10 ** extra;
    const gte = base * scale;
    if (gte > maxNumber) break;
    ranges.push({ gte, lte: Math.min(maxNumber, (base + 1) * scale - 1) });
  }
  return ranges;
}

/** Same « number the tenant SEES » rule as visibleOrderNumberWhere, over prefix ranges. */
function visibleOrderNumberPrefixWhere(digits: string): Prisma.OrderWhereInput | null {
  const ranges = orderNumberPrefixRanges(digits);
  if (ranges.length === 0) return null;
  return {
    OR: ranges.flatMap((r) => [{ displayNumber: r }, { displayNumber: null, orderNumber: r }]),
  };
}

/**
 * The order-number DIGITS typed in the palette (« 14 », « 0001 »,
 * « CMD-0000 », « BL/26-00014 »), for the prefix stage — or null. Same
 * reading as quickSearchOrderNumber (configured prefix or « CMD », never a
 * 9+ digit phone / tracking run, never letters-then-digits text), except
 * that an all-zero beginning is kept: it is the start of a padded number.
 */
export function quickSearchOrderDigits(raw: string, prefix?: string | null): string | null {
  const q = raw.trim();
  if (/^\d{9,}$/.test(q)) return null;
  const strip = (p: string | null | undefined): string | null => {
    const pre = p?.trim();
    if (!pre || (/^\d+$/.test(pre) && /^\d+$/.test(q))) return null;
    const m = q.match(new RegExp(`^${pre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[-\\s]?(.*)$`, "i"));
    return m ? m[1] : null;
  };
  const rest = strip(prefix) ?? strip(DEFAULT_ORDER_PREFIX) ?? q;
  return /^\d{1,10}$/.test(rest) ? rest : null;
}

export interface QuickSearchOrder {
  id: string;
  orderNumber: number;
  displayNumber: number | null;
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  externalNumber: string | null;
  customerName: string;
  /** The tracking number that matched, when the order was found through one of its shipments. */
  matchedTrackingNumber: string | null;
}

export async function findQuickSearchOrders(raw: string, prefix?: string | null): Promise<QuickSearchOrder[]> {
  const q = raw.trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  if (!q) return [];

  // Exact matches use plain `in` over case variants (exactMatchCandidates —
  // never an unescaped ILIKE); the partial stage uses the escaped `contains`.
  const exactTracking: Prisma.ShipmentWhereInput = { trackingNumber: { in: exactMatchCandidates(q) } };
  const partialTracking: Prisma.ShipmentWhereInput = { trackingNumber: { contains: q, mode: "insensitive" } };
  const n = quickSearchOrderNumber(q, prefix);
  const external = exactMatchCandidates(q.replace(/^#/, ""));
  const identifiers: Prisma.OrderWhereInput[] = [
    ...(n !== null ? [visibleOrderNumberWhere(n)] : []),
    ...(external.length > 0 ? [{ externalNumber: { in: external } }] : []),
  ];

  // Partial order number, on the digits as typed (« CMD-0000 » included).
  const typedDigits = quickSearchOrderDigits(q, prefix);
  const prefixWhere = typedDigits ? visibleOrderNumberPrefixWhere(typedDigits) : null;

  const stages: { where: Prisma.OrderWhereInput; tracking: Prisma.ShipmentWhereInput | null }[] = [
    { where: { shipments: { some: exactTracking } }, tracking: exactTracking },
    ...(identifiers.length > 0 ? [{ where: { OR: identifiers }, tracking: null }] : []),
    ...(prefixWhere ? [{ where: prefixWhere, tracking: null }] : []),
    ...(q.length >= MIN_PARTIAL_TRACKING_LENGTH
      ? [{ where: { shipments: { some: partialTracking } }, tracking: partialTracking }]
      : []),
  ];

  const found: QuickSearchOrder[] = [];
  for (const stage of stages) {
    const remaining = QUICK_SEARCH_ORDER_LIMIT - found.length;
    if (remaining <= 0) break;
    const rows = await prisma.order.findMany({
      where: { AND: [stage.where, { id: { notIn: found.map((o) => o.id) } }] },
      select: {
        id: true,
        orderNumber: true,
        displayNumber: true,
        source: true,
        externalNumber: true,
        customer: { select: { fullName: true } },
        // The matching shipment's number (none for an identifier match).
        shipments: {
          where: stage.tracking ?? { id: { in: [] } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { trackingNumber: true },
        },
      },
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: remaining,
    });
    for (const o of rows) {
      found.push({
        id: o.id,
        orderNumber: o.orderNumber,
        displayNumber: o.displayNumber,
        source: o.source,
        externalNumber: o.externalNumber,
        customerName: o.customer.fullName,
        matchedTrackingNumber: o.shipments[0]?.trackingNumber ?? null,
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Shipments (« Expéditions »)
// ---------------------------------------------------------------------------

export const QUICK_SEARCH_SHIPMENT_LIMIT = 5;

export interface QuickSearchShipment {
  id: string;
  orderId: string;
  trackingNumber: string;
  providerName: string;
  status: ShipmentStatus;
  providerStatusRaw: string | null;
}

/**
 * Command-palette SHIPMENT lookup, by tracking number only: EXACT first (as
 * typed, upper or lower case — exactMatchCandidates), then CONTAINS for 4+
 * characters, exactly like the order stages above. `excludeOrderIds` — the
 * orders the palette already lists — are skipped, so one parcel is never
 * shown twice. A failed API creation attempt (no carrier id) is left out, as
 * on /livraison/suivi (src/lib/queries/tracking.ts), where the result links.
 * Tenant-scoped by the `prisma` client (tenant extension + RLS).
 */
export async function findQuickSearchShipments(raw: string, excludeOrderIds: readonly string[] = []): Promise<QuickSearchShipment[]> {
  const q = raw.trim().slice(0, MAX_ORDER_SEARCH_LENGTH);
  if (!q) return [];

  const stages: Prisma.ShipmentWhereInput[] = [
    { trackingNumber: { in: exactMatchCandidates(q) } },
    ...(q.length >= MIN_PARTIAL_TRACKING_LENGTH ? [{ trackingNumber: { contains: q, mode: "insensitive" as const } }] : []),
  ];
  const base: Prisma.ShipmentWhereInput = {
    trackingNumber: { not: null },
    NOT: { status: "ECHEC", externalId: null, provider: { type: "API" } },
    ...(excludeOrderIds.length > 0 ? { orderId: { notIn: [...excludeOrderIds] } } : {}),
  };

  const found: QuickSearchShipment[] = [];
  for (const stage of stages) {
    const remaining = QUICK_SEARCH_SHIPMENT_LIMIT - found.length;
    if (remaining <= 0) break;
    const rows = await prisma.shipment.findMany({
      where: { AND: [base, stage, { id: { notIn: found.map((s) => s.id) } }] },
      select: {
        id: true,
        orderId: true,
        trackingNumber: true,
        status: true,
        providerStatusRaw: true,
        provider: { select: { name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: remaining,
    });
    for (const s of rows) {
      found.push({
        id: s.id,
        orderId: s.orderId,
        trackingNumber: s.trackingNumber ?? "",
        providerName: s.provider.name,
        status: s.status,
        providerStatusRaw: s.providerStatusRaw,
      });
    }
  }
  return found;
}
