import type { OrderChannel, Prisma } from "@prisma/client";
import { ORDER_CHANNEL_LABELS, RECORD_SOURCE_LABELS } from "@/lib/status-labels";
import type { AnalyticsPeriod } from "@/lib/analytics/period";

/**
 * Analytics filters (docs/adr/0051). Parsed from the URL, so every view is
 * shareable — but a filter is only ever ANDed onto the viewer's own scope by
 * the queries: an id the viewer may not read (another store, another
 * tenant's provider, a forged value) simply matches nothing. Filters narrow;
 * they never widen.
 */

/** Order origin, exactly the existing `displayOrderChannel` grouping. */
export const SOURCE_KEYS = [
  "WOOCOMMERCE",
  "SHOPIFY",
  "INTERNE:TELEPHONE",
  "INTERNE:WHATSAPP",
  "INTERNE:INSTAGRAM",
  "INTERNE:FACEBOOK",
  "INTERNE:SITE_WEB",
  "INTERNE:AUTRE",
] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export function sourceLabel(key: SourceKey): string {
  if (key === "WOOCOMMERCE" || key === "SHOPIFY") return RECORD_SOURCE_LABELS[key];
  return ORDER_CHANNEL_LABELS[key.slice("INTERNE:".length)] ?? ORDER_CHANNEL_LABELS.AUTRE;
}

/** Same rule as `displayOrderChannel`: a manual order with no channel shows as « Autre ». */
export function sourceKeyOf(order: { source: string; channel: string | null }): SourceKey {
  if (order.source === "WOOCOMMERCE" || order.source === "SHOPIFY") return order.source;
  const k = `INTERNE:${order.channel ?? "AUTRE"}`;
  return (SOURCE_KEYS as readonly string[]).includes(k) ? (k as SourceKey) : "INTERNE:AUTRE";
}

export interface AnalyticsFilters {
  source?: SourceKey;
  /** An ONLINE sales channel (multi-store tenants). */
  onlineChannelId?: string;
  providerId?: string;
  confirmerId?: string;
  agentId?: string;
  categoryId?: string;
  /** Offline only — Online orders have no location model (ADR 0050). */
  warehouseId?: string;
  /** An OFFLINE (store) sales channel. */
  storeChannelId?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = (v: string | undefined) => (v && ID.test(v) ? v : undefined);

export function parseAnalyticsFilters(sp: Record<string, string | string[] | undefined>): AnalyticsFilters {
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const source = one("source");
  return {
    source: (SOURCE_KEYS as readonly string[]).includes(source ?? "") ? (source as SourceKey) : undefined,
    onlineChannelId: id(one("canal")),
    providerId: id(one("transporteur")),
    confirmerId: id(one("confirmateur")),
    agentId: id(one("agent")),
    categoryId: id(one("categorie")),
    warehouseId: id(one("emplacement")),
    storeChannelId: id(one("magasin")),
    sort: one("sort") && /^[a-zA-Z]{1,32}$/.test(one("sort")!) ? one("sort") : undefined,
    dir: one("dir") === "asc" ? "asc" : one("dir") === "desc" ? "desc" : undefined,
  };
}

/** URL parameter name of each filter — the inverse of `parseAnalyticsFilters`. */
const PARAM: Record<keyof AnalyticsFilters, string> = {
  source: "source",
  onlineChannelId: "canal",
  providerId: "transporteur",
  confirmerId: "confirmateur",
  agentId: "agent",
  categoryId: "categorie",
  warehouseId: "emplacement",
  storeChannelId: "magasin",
  sort: "sort",
  dir: "dir",
};

/** `period` + filters as URL params (no empty entries) — links, form, CSV export. */
export function analyticsParams(
  period: AnalyticsPeriod,
  filters: AnalyticsFilters,
  override: Partial<Record<keyof AnalyticsFilters, string | undefined>> = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(period.params)) if (v) out[k] = v;
  const merged = { ...filters, ...override } as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(merged)) if (v) out[PARAM[k as keyof AnalyticsFilters]] = v;
  return out;
}

export function analyticsQuery(
  period: AnalyticsPeriod,
  filters: AnalyticsFilters,
  override: Partial<Record<keyof AnalyticsFilters, string | undefined>> = {}
): string {
  return new URLSearchParams(analyticsParams(period, filters, override)).toString();
}

/** The Online-order part of the filters, as a Prisma `where` (to be ANDed). */
export function orderFilterWhere(f: AnalyticsFilters): Prisma.OrderWhereInput {
  const and: Prisma.OrderWhereInput[] = [];
  if (f.source === "WOOCOMMERCE" || f.source === "SHOPIFY") and.push({ source: f.source });
  else if (f.source === "INTERNE:AUTRE") and.push({ source: "INTERNE", OR: [{ channel: null }, { channel: "AUTRE" }] });
  else if (f.source) and.push({ source: "INTERNE", channel: f.source.slice("INTERNE:".length) as OrderChannel });
  if (f.onlineChannelId) and.push({ salesChannelId: f.onlineChannelId });
  return and.length ? { AND: and } : {};
}

/** Generic server-side sort for a factual table: only whitelisted columns. */
export function sortRows<T>(rows: T[], filters: AnalyticsFilters, columns: Partial<Record<string, (r: T) => number | string | null>>, fallback: string): T[] {
  const key = filters.sort && columns[filters.sort] ? filters.sort : fallback;
  const get = columns[key]!;
  const sign = filters.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * sign;
  });
}
