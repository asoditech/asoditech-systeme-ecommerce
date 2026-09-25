import { describe, expect, it } from "vitest";
import {
  formatOrderNumber,
  formatTransferNumber,
  formatStocktakeNumber,
  displayOrderChannel,
  returnStateLabel,
} from "@/lib/format";

describe("reference number formatters", () => {
  it("formatStocktakeNumber pads to 6 digits with an INV- prefix (Phase 32c)", () => {
    expect(formatStocktakeNumber(1)).toBe("INV-000001");
    expect(formatStocktakeNumber(123)).toBe("INV-000123");
    expect(formatStocktakeNumber(1_234_567)).toBe("INV-1234567");
  });

  it("stays consistent with the sibling formatters", () => {
    expect(formatOrderNumber(123)).toBe("CMD-000123");
    expect(formatTransferNumber(123)).toBe("TR-000123");
    expect(formatStocktakeNumber(123)).toBe("INV-000123");
  });
});

describe("displayOrderChannel", () => {
  it("shows the store name for an imported order, ignoring channel entirely", () => {
    expect(displayOrderChannel({ source: "WOOCOMMERCE", channel: null })).toBe("WooCommerce");
    expect(displayOrderChannel({ source: "SHOPIFY", channel: "WHATSAPP" })).toBe("Shopify");
  });

  it("shows the chosen channel for a manually-created order", () => {
    expect(displayOrderChannel({ source: "INTERNE", channel: "WHATSAPP" })).toBe("WhatsApp");
    expect(displayOrderChannel({ source: "INTERNE", channel: "TELEPHONE" })).toBe("Téléphone");
  });

  it("falls back to Autre for an INTERNE order with no channel (pre-existing data)", () => {
    expect(displayOrderChannel({ source: "INTERNE", channel: null })).toBe("Autre");
    expect(displayOrderChannel({ source: "INTERNE" })).toBe("Autre");
  });
});

describe("returnStateLabel (Group 1 — Order/Sale return-state tags)", () => {
  it("is null when nothing was consumed or nothing was returned", () => {
    expect(returnStateLabel(0, 0)).toBeNull();
    expect(returnStateLabel(3, 0)).toBeNull();
    expect(returnStateLabel(0, 0)).toBeNull();
  });

  it("reads partial when returned is less than consumed", () => {
    expect(returnStateLabel(3, 1)).toBe("Retour partiel — 1/3");
  });

  it("reads complete when returned reaches (or, defensively, exceeds) consumed", () => {
    expect(returnStateLabel(3, 3)).toBe("Retour complet — 3/3");
    expect(returnStateLabel(3, 4)).toBe("Retour complet — 4/3");
  });
});
