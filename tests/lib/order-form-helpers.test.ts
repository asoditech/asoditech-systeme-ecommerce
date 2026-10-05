import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyShippingPrefill, customerShippingDefaults } from "@/lib/orders/shipping-prefill";
import { productChips, productLineLabel } from "@/lib/catalog/product-chips";
import { ProductChips } from "@/components/orders/product-chips";
import { SelectedLineChips } from "@/components/orders/selected-line-chips";

const empty = { address: "", city: "", phone: "" };

describe("new order — delivery prefill from the selected customer", () => {
  it("uses the default saved address first, then the customer's own city / phone", () => {
    expect(
      customerShippingDefaults({ phone: "0611", city: "Fès", addresses: [{ addressLine1: "1 Rue X", city: "Rabat", phone: "0622" }] })
    ).toEqual({ address: "1 Rue X", city: "Rabat", phone: "0622" });
    expect(customerShippingDefaults({ phone: "0611", city: "Fès", addresses: [] })).toEqual({ address: "", city: "Fès", phone: "0611" });
    expect(customerShippingDefaults({ phone: null, city: null, defaultAddress: { addressLine1: "2 Rue Y", city: "Tanger", phone: null } })).toEqual({
      address: "2 Rue Y",
      city: "Tanger",
      phone: "",
    });
  });

  it("fills empty fields; a value typed by hand is never overwritten", () => {
    const a = { address: "1 Rue X", city: "Rabat", phone: "0611" };
    expect(applyShippingPrefill(empty, empty, a)).toEqual(a);
    expect(applyShippingPrefill({ address: "Mon adresse", city: "", phone: "" }, empty, a)).toEqual({ ...a, address: "Mon adresse" });
  });

  it("switching customer replaces what the previous prefill put there (untouched), keeps edits, clears what the new one lacks", () => {
    const a = { address: "1 Rue X", city: "Rabat", phone: "0611" };
    const b = { address: "", city: "Fès", phone: "0622" };
    const edited = { ...a, phone: "0699" }; // phone changed by hand for this order
    expect(applyShippingPrefill(edited, a, b)).toEqual({ address: "", city: "Fès", phone: "0699" });
  });
});

describe("« Produits » chips", () => {
  it("adds variation options to the name unless the name already has them", () => {
    expect(productLineLabel("Basket", { Couleur: "Rouge", Taille: "42" })).toBe("Basket — Rouge / 42");
    expect(productLineLabel("T-shirt - Rouge", { Couleur: "Rouge" })).toBe("T-shirt - Rouge");
    expect(productLineLabel("Casquette", null)).toBe("Casquette");
  });

  it("merges identical lines, shows at most N chips and a +N rest", () => {
    const r = productChips([
      { name: "Bolder Smile", quantity: 1 },
      { name: "Whitening Strips", quantity: 1 },
      { name: "Bolder Smile", quantity: 1 },
      { name: "Brosse", quantity: 3 },
      { name: "Gel", quantity: 1 },
    ]);
    expect(r.chips).toEqual([
      { label: "Bolder Smile", quantity: 2 },
      { label: "Whitening Strips", quantity: 1 },
    ]);
    expect(r.more).toBe(2);
  });

  it("renders compact one-line chips with a full list in the tooltip; empty → —", () => {
    const html = renderToStaticMarkup(
      createElement(ProductChips, { lines: [{ name: "Bolder Smile", quantity: 2 }, { name: "Strips", quantity: 1 }, { name: "Gel", quantity: 1 }] })
    );
    expect(html).toContain("Bolder Smile");
    expect(html).toContain("×2");
    expect(html).toContain("+1");
    expect(html).toContain("Gel ×1"); // in the title tooltip
    expect(html).toContain("truncate");
    expect(renderToStaticMarkup(createElement(ProductChips, { lines: [] }))).toContain("—");
  });

  it("picker chips list the selected lines with a remove button", () => {
    const html = renderToStaticMarkup(
      createElement(SelectedLineChips, { lines: [{ key: "a", label: "Basket — Rouge", quantity: 1 }], onRemove: () => {} })
    );
    expect(html).toContain("Basket — Rouge");
    expect(html).toContain('aria-label="Retirer Basket — Rouge"');
  });
});
