import { describe, expect, it } from "vitest";
import { isRecentlyPlaced } from "@/lib/integrations/shared/order-recency";

describe("isRecentlyPlaced", () => {
  it("is true for an order placed minutes ago", () => {
    expect(isRecentlyPlaced(new Date(Date.now() - 5 * 60_000).toISOString())).toBe(true);
  });

  it("is true for a future date (clock skew / test fixtures)", () => {
    expect(isRecentlyPlaced(new Date(Date.now() + 5 * 60_000).toISOString())).toBe(true);
  });

  it("is false for an order placed a week ago", () => {
    expect(isRecentlyPlaced(new Date(Date.now() - 7 * 86_400_000).toISOString())).toBe(false);
  });

  it("is false for an order placed months ago (a history backfill)", () => {
    expect(isRecentlyPlaced(new Date(Date.now() - 120 * 86_400_000).toISOString())).toBe(false);
  });

  it("is false for an unparseable date", () => {
    expect(isRecentlyPlaced("not a date")).toBe(false);
    expect(isRecentlyPlaced("")).toBe(false);
  });
});
