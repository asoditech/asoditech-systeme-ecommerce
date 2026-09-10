import { describe, expect, it } from "vitest";
import { NAV_GROUPS } from "@/components/layout/sidebar-nav";

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
