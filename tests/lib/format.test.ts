import { describe, expect, it } from "vitest";
import { formatOrderNumber, formatTransferNumber, formatStocktakeNumber, displayOrderChannel } from "@/lib/format";

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
