import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LOCATION_COST_LABELS, locationCostSourceLabel } from "@/lib/catalog/location-cost-labels";
import { describeLocationCost } from "@/lib/catalog/location-cost";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { LocationCostDisplay } = await import("@/components/inventory/location-cost-display");
const { LocationCostEditor } = await import("@/components/inventory/location-cost-editor");

const display = (locationCost: number | null, globalCost: number | null) => {
  const { cost, source } = describeLocationCost(locationCost, globalCost, null);
  return renderToStaticMarkup(createElement(LocationCostDisplay, { cost: cost?.toString() ?? null, source }));
};

describe("location purchase cost — wording", () => {
  it("uses the approved, unambiguous labels", () => {
    expect(LOCATION_COST_LABELS).toMatchObject({
      location: "Coût d'achat de cet emplacement",
      global: "Coût global du produit",
      usesGlobal: "Utilise le coût global du produit",
    });
    expect(locationCostSourceLabel("location")).toBe("Coût d'achat de cet emplacement");
    expect(locationCostSourceLabel("global")).toBe("Coût global du produit");
  });

  it("Casablanca 110 → « Coût d'achat de cet emplacement »; General Stock 100 → « Coût global du produit »", () => {
    const casa = display(110, 100);
    expect(casa).toMatch(/110,00/);
    expect(casa).toContain("Coût d&#x27;achat de cet emplacement");
    const general = display(null, 100);
    expect(general).toMatch(/100,00/);
    expect(general).toContain("Coût global du produit");
    expect(general).not.toContain("cet emplacement");
  });

  it("no cost anywhere → « Non renseigné »", () => {
    expect(display(null, null)).toContain("Non renseigné");
  });

  it("the editor trigger is a small icon button naming the location (dialog closed)", () => {
    const html = renderToStaticMarkup(
      createElement(LocationCostEditor, { inventoryItemId: "i1", locationName: "Casablanca", itemLabel: "Sac", locationCost: "110", globalCost: "100" })
    );
    expect(html).toContain('aria-label="Modifier le coût d&#x27;achat de Casablanca"');
    expect(html).not.toContain("Utiliser le coût global"); // inside the closed dialog
  });
});
