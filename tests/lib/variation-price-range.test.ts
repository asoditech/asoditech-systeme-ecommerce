import { describe, expect, it } from "vitest";
import { formatPriceRange, variationPriceRange } from "@/lib/catalog/price-range";
import { formatCurrency } from "@/lib/format";

/** « Prix de vente » of a variable product: own price ?? parent price, never invented. */
describe("variationPriceRange", () => {
  it("a variation without its own price inherits the parent's (was shown as « — »)", () => {
    expect(variationPriceRange("199.00", [{ price: null }, { price: null }])).toEqual({ min: 199, max: 199 });
    expect(formatPriceRange(variationPriceRange("199.00", [{ price: null }]))).toBe(formatCurrency("199"));
  });

  it("mixes own and inherited prices into a min–max range", () => {
    const range = variationPriceRange("150", [{ price: "120" }, { price: null }, { price: "180.5" }]);
    expect(range).toEqual({ min: 120, max: 180.5 });
    expect(formatPriceRange(range)).toBe(`${formatCurrency("120")} – ${formatCurrency("180.5")}`);
  });

  it("stays « — » when nothing is priced (WooCommerce parent at 0, variations without price)", () => {
    expect(variationPriceRange("0", [{ price: null }, { price: "0" }])).toBeNull();
    expect(formatPriceRange(null)).toBe("—");
  });

  it("accepts Prisma Decimal-like values", () => {
    const dec = (v: string) => ({ toString: () => v });
    expect(variationPriceRange(dec("99"), [{ price: dec("89") }, { price: null }])).toEqual({ min: 89, max: 99 });
  });
});
