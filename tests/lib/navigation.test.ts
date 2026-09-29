import { describe, expect, it } from "vitest";
import { NAV_GROUPS, hasNavPermission } from "@/components/layout/sidebar-nav";

/**
 * Client feedback #9: Marketing is temporarily hidden from navigation.
 * The route, its `marketing.view` permission and the DB models stay in
 * place — only the sidebar entry is removed.
 */
describe("sidebar navigation", () => {
  const allItems = NAV_GROUPS.flatMap((g) => g.items);

  it("does not list Marketing", () => {
    expect(allItems.some((i) => i.href === "/marketing")).toBe(false);
    expect(allItems.some((i) => i.label === "Marketing")).toBe(false);
  });

  it("still lists the core sections", () => {
    const hrefs = allItems.map((i) => i.href);
    for (const href of ["/tableau-de-bord", "/commandes", "/produits", "/livraison", "/finance"]) {
      expect(hrefs).toContain(href);
    }
  });
});

/**
 * Phase 2 (user-management UX v2): discoverability for the already-working
 * /operations/nouvelle fork — the sidebar entry must reuse the SAME OR
 * permission check as the pre-existing command-palette entry, never a
 * separate "must hold both" rule.
 */
describe("Nouvelle opération sidebar entry", () => {
  const allItems = NAV_GROUPS.flatMap((g) => g.items);
  const item = allItems.find((i) => i.href === "/operations/nouvelle");

  it("is present, in the Ventes group, targeting the existing fork page", () => {
    expect(item).toBeDefined();
    const group = NAV_GROUPS.find((g) => g.items.includes(item!));
    expect(group?.label).toBe("Ventes");
  });

  it("requires orders.create OR sales.create — never both", () => {
    expect(item!.permission).toEqual(["orders.create", "sales.create"]);
  });
});

describe("hasNavPermission", () => {
  it("matches a single required permission directly", () => {
    expect(hasNavPermission(new Set(["orders.view"]), "orders.view")).toBe(true);
    expect(hasNavPermission(new Set(["orders.view"]), "sales.view")).toBe(false);
  });

  it("matches an array requirement with OR semantics (any one is enough)", () => {
    expect(hasNavPermission(new Set(["orders.create"]), ["orders.create", "sales.create"])).toBe(true);
    expect(hasNavPermission(new Set(["sales.create"]), ["orders.create", "sales.create"])).toBe(true);
    expect(hasNavPermission(new Set(["customers.view"]), ["orders.create", "sales.create"])).toBe(false);
  });
});
