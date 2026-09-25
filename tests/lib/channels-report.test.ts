import { describe, expect, it } from "vitest";
import { combinedChannelRevenue } from "@/lib/queries/reports/channels";

/**
 * Batch 3, Task 5 — the dashboard's "Chiffre d'affaires total" KPI reuses
 * this exact function (the same one getChannelReport's own `total` uses),
 * so the two can never drift apart.
 */
describe("combinedChannelRevenue", () => {
  it("adds online revenue and offline net sales", () => {
    expect(combinedChannelRevenue(1000, 250)).toBe(1250);
  });

  it("rounds to 2 decimal places", () => {
    expect(combinedChannelRevenue(10.1, 0.006)).toBe(10.11);
  });

  it("handles a zero side", () => {
    expect(combinedChannelRevenue(500, 0)).toBe(500);
    expect(combinedChannelRevenue(0, 500)).toBe(500);
  });
});
