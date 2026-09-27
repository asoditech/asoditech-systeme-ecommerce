import { describe, expect, it } from "vitest";
import {
  formatOrderNumber,
  formatTransferNumber,
  formatStocktakeNumber,
  displayOrderNumber,
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

// Batch 17 — BusinessSettings.orderNumberPrefix was persisted but never
// actually consumed by any order-number display; formatOrderNumber/
// displayOrderNumber now accept the tenant's real prefix, defaulting to
// "CMD" (unchanged behaviour) for any caller that doesn't pass one.
describe("formatOrderNumber / displayOrderNumber — configurable prefix (Batch 17)", () => {
  it("formatOrderNumber uses a custom prefix when given one, CMD otherwise", () => {
    expect(formatOrderNumber(123, "ORD")).toBe("ORD-000123");
    expect(formatOrderNumber(123)).toBe("CMD-000123");
  });

  it("displayOrderNumber applies the custom prefix to an INTERNE order", () => {
    const order = { orderNumber: 42, displayNumber: null, source: "INTERNE" as const, externalNumber: null };
    expect(displayOrderNumber(order, "ORD")).toBe("ORD-000042");
    expect(displayOrderNumber(order)).toBe("CMD-000042"); // omitted prefix keeps old behaviour
  });

  it("a synced (WooCommerce/Shopify) order still shows its own external number, prefix or not", () => {
    const order = { orderNumber: 42, displayNumber: null, source: "WOOCOMMERCE" as const, externalNumber: "9001" };
    expect(displayOrderNumber(order, "ORD")).toBe("#9001");
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
