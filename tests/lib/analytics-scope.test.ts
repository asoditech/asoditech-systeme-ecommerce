import { describe, expect, it } from "vitest";
import {
  blockedReason,
  hasScopeFilter,
  isBlocked,
  onlineScopeLabel,
  pnlSourceOf,
  scopeControls,
  storeScopeLabel,
  unsupportedFilters,
  withoutDimensions,
} from "@/lib/analytics/scope";
import { parseAnalyticsFilters, analyticsQuery, sourceLabel } from "@/lib/analytics/filters";
import { resolveAnalyticsPeriod } from "@/lib/analytics/period";

/**
 * Requirement A — the analytics scope model (pure). A section is computed
 * only when it can honour every active filter; otherwise it is blocked and
 * replaced by an explicit « non filtrable » notice.
 */
describe("analytics scope — which section honours which filter", () => {
  it("no filter → every section computed", () => {
    for (const b of ["online", "commissions", "pnl", "store"] as const) expect(isBlocked(b, {})).toBe(false);
    expect(hasScopeFilter({})).toBe(false);
  });

  it("a store (magasin) selection blocks Online, commissions and P&L, never the store section", () => {
    const f = parseAnalyticsFilters({ magasin: "store_rabat" });
    expect(f.storeChannelId).toBe("store_rabat");
    expect(unsupportedFilters("online", f)).toEqual(["storeChannelId"]);
    expect(unsupportedFilters("commissions", f)).toEqual(["storeChannelId"]);
    expect(unsupportedFilters("pnl", f)).toEqual(["storeChannelId"]);
    expect(isBlocked("store", f)).toBe(false);
    expect(hasScopeFilter(f)).toBe(true);
  });

  it("a location (emplacement) selection blocks the Online side the same way", () => {
    const f = parseAnalyticsFilters({ emplacement: "wh_1" });
    expect(isBlocked("online", f)).toBe(true);
    expect(isBlocked("commissions", f)).toBe(true);
    expect(isBlocked("pnl", f)).toBe(true);
    expect(isBlocked("store", f)).toBe(false);
  });

  it("an Online origin / channel blocks the store section (a POS sale has neither)", () => {
    expect(unsupportedFilters("store", { source: "SHOPIFY" })).toEqual(["source"]);
    expect(unsupportedFilters("store", { onlineChannelId: "c1" })).toEqual(["onlineChannelId"]);
    expect(isBlocked("online", { source: "SHOPIFY", onlineChannelId: "c1" })).toBe(false);
    expect(isBlocked("commissions", { source: "INTERNE:WHATSAPP" })).toBe(false);
  });

  it("P&L: only WooCommerce / Shopify sources are expressible; an Online channel blocks it", () => {
    expect(pnlSourceOf({})).toBeUndefined();
    expect(pnlSourceOf({ source: "WOOCOMMERCE" })).toBe("WOOCOMMERCE");
    expect(pnlSourceOf({ source: "INTERNE:TELEPHONE" })).toBeNull();
    expect(isBlocked("pnl", { source: "SHOPIFY" })).toBe(false);
    expect(unsupportedFilters("pnl", { source: "INTERNE:TELEPHONE" })).toEqual(["source"]);
    expect(unsupportedFilters("pnl", { onlineChannelId: "c1" })).toEqual(["onlineChannelId"]);
  });

  it("both sides filtered at once → every section blocked except none can mix", () => {
    const f = { source: "SHOPIFY" as const, storeChannelId: "s1" };
    expect(isBlocked("online", f)).toBe(true);
    expect(isBlocked("store", f)).toBe(true);
  });

  it("forged ids are rejected by the parser (filters narrow, never widen)", () => {
    const f = parseAnalyticsFilters({ magasin: "x' OR 1=1", emplacement: "a".repeat(80) });
    expect(f.storeChannelId).toBeUndefined();
    expect(f.warehouseId).toBeUndefined();
  });
});

describe("notice text and clear-filter link", () => {
  it("explains WHY in French and names the dimension", () => {
    expect(blockedReason("online", ["storeChannelId"])).toMatch(/^Non filtrable par magasin — les commandes en ligne/);
    expect(blockedReason("commissions", ["warehouseId"])).toContain("emplacement");
    expect(blockedReason("pnl", ["storeChannelId"])).toContain("dépenses");
    expect(blockedReason("store", ["source", "onlineChannelId"])).toMatch(/^Non filtrable par origine ni canal en ligne/);
  });

  it("removing the blocking dims keeps the period and the other filters", () => {
    const period = resolveAnalyticsPeriod({ from: "2026-03-01", to: "2026-03-31" });
    const f = { storeChannelId: "s1", categoryId: "cat1" };
    const q = new URLSearchParams(analyticsQuery(period, withoutDimensions(f, ["storeChannelId"])));
    expect(q.get("magasin")).toBeNull();
    expect(q.get("categorie")).toBe("cat1");
    expect(q.get("from")).toBe("2026-03-01");
    expect(f.storeChannelId).toBe("s1"); // input not mutated
  });
});

describe("scope labels and controls", () => {
  const names = { stores: new Map([["s1", "Rabat"]]), warehouses: new Map([["w1", "Dépôt Casa"]]) };
  it("« Tous vos magasins » vs one store; an unreadable id is labelled, not resolved", () => {
    expect(storeScopeLabel({}, names)).toBe("Tous vos magasins · tous vos emplacements");
    expect(storeScopeLabel({ storeChannelId: "s1", warehouseId: "w1" }, names)).toBe("Magasin : Rabat · Emplacement : Dépôt Casa");
    expect(storeScopeLabel({ storeChannelId: "other-tenant" }, names)).toContain("inaccessible");
  });

  it("Online scope label", () => {
    expect(onlineScopeLabel({}, sourceLabel, new Map())).toBe("Toutes les origines · tous les canaux en ligne");
    expect(onlineScopeLabel({ onlineChannelId: "c1" }, sourceLabel, new Map([["c1", "Boutique 2"]]))).toContain("Canal : Boutique 2");
  });

  it("shared controls: Online selects only with Online access, channel only when > 1, store selects only with store access", () => {
    const online = { sources: [{ value: "SHOPIFY", label: "Shopify" }], onlineChannels: [{ id: "c1", name: "Web" }] };
    const store = { storeChannels: [{ id: "s1", name: "Rabat" }], warehouses: [{ id: "w1", name: "Dépôt" }] };
    expect(scopeControls({}, online, store).map((c) => c.paramKey)).toEqual(["source", "magasin", "emplacement"]);
    expect(scopeControls({}, { ...online, onlineChannels: [...online.onlineChannels, { id: "c2", name: "B2" }] }, null).map((c) => c.paramKey)).toEqual(["source", "canal"]);
    const ctl = scopeControls({ storeChannelId: "s1" }, null, store);
    expect(ctl[0]).toMatchObject({ paramKey: "magasin", value: "s1", allLabel: "Tous les magasins" });
    expect(ctl[1].allLabel).toBe("Tous les emplacements (dépôts)");
  });
});
