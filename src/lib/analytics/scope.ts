import type { AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * Analytics filter SCOPE — which section can honour which filter (Requirement
 * A, unified reports filters). Pure: no database, no session.
 *
 * The business model (docs/adr/0050, 0051) has two disjoint populations:
 *   - Online `Order`s — origin (`source`/`channel`) and ONLINE sales channel,
 *     but NO physical store and NO location (an Online order is never tied to
 *     a store; ADR 0037/0050 rejected location-based Online scoping);
 *   - in-store `Sale`s — OFFLINE sales channel (« magasin ») and location
 *     (« emplacement »), but no Online origin / Online channel.
 * Commissions are written on Online orders only (ADR 0022/0049), and the
 * Finance P&L (`computePeriodProfitability`) is Online orders + ALL the
 * tenant's expenses (an `Expense` has no store / location column).
 *
 * So a section is NEVER computed under a filter it cannot honour: it is
 * hidden and replaced by an explicit « non filtrable par … » notice — never
 * silently shown with global numbers next to filtered ones.
 */

export type ScopeDimension = "source" | "onlineChannelId" | "storeChannelId" | "warehouseId";

export type AnalyticsBlock = "online" | "commissions" | "pnl" | "store";

/** The dimensions each block can honour. Anything else, when active, blocks it. */
const HONOURED: Record<AnalyticsBlock, readonly ScopeDimension[]> = {
  online: ["source", "onlineChannelId"],
  commissions: ["source", "onlineChannelId"],
  // Finance's own definition: filterable by external shop source only (see `pnlSourceOf`).
  pnl: ["source"],
  store: ["storeChannelId", "warehouseId"],
};

const ALL_DIMENSIONS: readonly ScopeDimension[] = ["source", "onlineChannelId", "storeChannelId", "warehouseId"];

export const SCOPE_DIMENSION_LABELS: Record<ScopeDimension, string> = {
  source: "origine",
  onlineChannelId: "canal en ligne",
  storeChannelId: "magasin",
  warehouseId: "emplacement",
};

/**
 * The P&L's own source restriction: `computePeriodProfitability` takes a
 * `RecordSource`, so only WooCommerce / Shopify are expressible. Returns the
 * source to pass, `undefined` for « all », or `null` when the active source
 * filter (a manual-order channel) cannot be honoured.
 */
export function pnlSourceOf(filters: Pick<AnalyticsFilters, "source">): "WOOCOMMERCE" | "SHOPIFY" | undefined | null {
  if (!filters.source) return undefined;
  return filters.source === "WOOCOMMERCE" || filters.source === "SHOPIFY" ? filters.source : null;
}

/** Active filters `block` cannot honour (empty = the block is fully filtered). */
export function unsupportedFilters(block: AnalyticsBlock, filters: AnalyticsFilters): ScopeDimension[] {
  const out = ALL_DIMENSIONS.filter((d) => filters[d] && !HONOURED[block].includes(d));
  if (block === "pnl" && pnlSourceOf(filters) === null) out.unshift("source");
  return out;
}

export function isBlocked(block: AnalyticsBlock, filters: AnalyticsFilters): boolean {
  return unsupportedFilters(block, filters).length > 0;
}

/** True when at least one scope filter (origin, online channel, store, location) is set. */
export function hasScopeFilter(filters: AnalyticsFilters): boolean {
  return ALL_DIMENSIONS.some((d) => Boolean(filters[d]));
}

/** `filters` without the given dimensions — for the « retirer le filtre » link. */
export function withoutDimensions(filters: AnalyticsFilters, dims: readonly ScopeDimension[]): AnalyticsFilters {
  const out = { ...filters };
  for (const d of dims) delete out[d];
  return out;
}

const joinFr = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ni ${items[items.length - 1]}`);

/** The French explanation shown in place of a block that cannot honour the active filters. */
export function blockedReason(block: AnalyticsBlock, dims: readonly ScopeDimension[]): string {
  const labels = dims.map((d) => SCOPE_DIMENSION_LABELS[d]);
  const head = `Non filtrable par ${joinFr(labels)}`;
  const storeSide = dims.some((d) => d === "storeChannelId" || d === "warehouseId");
  switch (block) {
    case "online":
      return `${head} — les commandes en ligne ne sont rattachées à aucun magasin ni emplacement. Section masquée pour ne pas afficher des chiffres en ligne globaux sous ce filtre.`;
    case "commissions":
      return `${head} — les commissions sont calculées sur les commandes en ligne, qui n'ont ni magasin ni emplacement. Section masquée.`;
    case "pnl":
      return storeSide
        ? `${head} — la rentabilité (Finance) porte sur les commandes en ligne et sur toutes les dépenses du compte ; ni les unes ni les autres ne sont rattachées à un magasin ou à un emplacement. Section masquée.`
        : `${head} — la rentabilité suit la définition de Finance, filtrable par boutique (WooCommerce / Shopify) uniquement. Section masquée.`;
    case "store":
      return `${head} — une vente en magasin n'a pas d'origine ni de canal en ligne. Section masquée pour ne pas afficher les ventes de tous vos magasins sous ce filtre.`;
  }
}

/**
 * The label of the store scope, e.g. « Magasin : Rabat » or « Tous vos
 * magasins ». `names` resolves ids the viewer may read; an id that is not in
 * it (foreign / forged) matches nothing in the queries and is shown as such.
 */
export function storeScopeLabel(filters: Pick<AnalyticsFilters, "storeChannelId" | "warehouseId">, names: { stores: Map<string, string>; warehouses: Map<string, string> }): string {
  const parts: string[] = [];
  parts.push(filters.storeChannelId ? `Magasin : ${names.stores.get(filters.storeChannelId) ?? "inaccessible (aucune vente)"}` : "Tous vos magasins");
  parts.push(filters.warehouseId ? `Emplacement : ${names.warehouses.get(filters.warehouseId) ?? "inaccessible (aucune vente)"}` : "tous vos emplacements");
  return parts.join(" · ");
}

/** The label of the Online scope, e.g. « Origine : Shopify · Tous les canaux en ligne ». */
export function onlineScopeLabel(filters: Pick<AnalyticsFilters, "source" | "onlineChannelId">, sourceName: (k: NonNullable<AnalyticsFilters["source"]>) => string, channels: Map<string, string>): string {
  const parts: string[] = [];
  parts.push(filters.source ? `Origine : ${sourceName(filters.source)}` : "Toutes les origines");
  parts.push(filters.onlineChannelId ? `Canal : ${channels.get(filters.onlineChannelId) ?? "inaccessible (aucune commande)"}` : "tous les canaux en ligne");
  return parts.join(" · ");
}

/** One filter select of the analytics toolbar (same shape as `AnalyticsFilterControl`). */
export interface ScopeControl {
  paramKey: string;
  value?: string;
  allLabel: string;
  options: { value: string; label: string }[];
}

/**
 * The ONE set of scope selects shared by every analytics page: origin and
 * Online channel (only with Online access; the channel only when the tenant
 * has more than one), store and location (only with store access). The
 * options are exactly what the viewer may read — the queries re-apply that
 * scope regardless, so a forged id narrows to nothing.
 */
export function scopeControls(
  filters: AnalyticsFilters,
  online: { sources: { value: string; label: string }[]; onlineChannels: { id: string; name: string }[] } | null,
  store: { storeChannels: { id: string; name: string }[]; warehouses: { id: string; name: string }[] } | null
): ScopeControl[] {
  const out: ScopeControl[] = [];
  if (online) {
    out.push({ paramKey: "source", value: filters.source, allLabel: "Toutes les origines", options: online.sources });
    if (online.onlineChannels.length > 1)
      out.push({ paramKey: "canal", value: filters.onlineChannelId, allLabel: "Tous les canaux en ligne", options: online.onlineChannels.map((c) => ({ value: c.id, label: c.name })) });
  }
  if (store) {
    out.push({ paramKey: "magasin", value: filters.storeChannelId, allLabel: "Tous les magasins", options: store.storeChannels.map((c) => ({ value: c.id, label: c.name })) });
    out.push({ paramKey: "emplacement", value: filters.warehouseId, allLabel: "Tous les emplacements (dépôts)", options: store.warehouses.map((w) => ({ value: w.id, label: w.name })) });
  }
  return out;
}
