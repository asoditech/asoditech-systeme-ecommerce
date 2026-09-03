import { describe, expect, it } from "vitest";
import { formatOrderNumber, formatTransferNumber, formatStocktakeNumber } from "@/lib/format";

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
