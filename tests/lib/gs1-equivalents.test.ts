import { describe, expect, it } from "vitest";
import { gtinEquivalents } from "@/lib/catalog/gs1";

/** The 12/13/14-digit spellings of one GTIN a scanner may send (src/lib/catalog/gs1.ts). */
describe("gtinEquivalents", () => {
  it("UPC-A ↔ EAN-13 ↔ GTIN-14 for a valid code", () => {
    expect(gtinEquivalents("012345678905")).toEqual(["0012345678905", "00012345678905"]);
    expect(gtinEquivalents("0012345678905")).toEqual(["012345678905", "00012345678905"]);
    expect(gtinEquivalents("00012345678905")).toEqual(["012345678905", "0012345678905"]);
  });

  it("an EAN-13 without a leading zero has only its GTIN-14 form", () => {
    expect(gtinEquivalents("6111234567895")).toEqual(["06111234567895"]);
  });

  it("never reinterprets a code whose check digit is wrong, a non-numeric code or another length", () => {
    expect(gtinEquivalents("012345678900")).toEqual([]);
    expect(gtinEquivalents("ABC-123")).toEqual([]);
    expect(gtinEquivalents("12345670")).toEqual([]);
    expect(gtinEquivalents("")).toEqual([]);
    expect(gtinEquivalents(null)).toEqual([]);
  });
});
