import { describe, expect, it } from "vitest";
import { suggestReceptionReference } from "@/lib/purchases/reception-reference";

/** Batch 9, Group 9 — reception document reference smart default. */
describe("suggestReceptionReference", () => {
  it("builds YYMMDD-XXX-001 from the date and the first 3 letters of the supplier name, uppercased", () => {
    expect(suggestReceptionReference(new Date(2026, 8, 26), "Ayoub Textiles")).toBe("260926-AYO-001");
  });

  it("falls back to the date-only portion when no supplier is known yet", () => {
    expect(suggestReceptionReference(new Date(2026, 8, 26), null)).toBe("260926");
    expect(suggestReceptionReference(new Date(2026, 8, 26), undefined)).toBe("260926");
    expect(suggestReceptionReference(new Date(2026, 8, 26), "")).toBe("260926");
  });

  it("strips accents and non-letter characters from the supplier name before taking the first 3 letters", () => {
    expect(suggestReceptionReference(new Date(2026, 1, 3), "Étoffé & Cie")).toBe("260203-ETO-001");
  });

  it("pads month and day to 2 digits", () => {
    expect(suggestReceptionReference(new Date(2026, 0, 5), "Ba")).toBe("260105-BA-001");
  });
});
