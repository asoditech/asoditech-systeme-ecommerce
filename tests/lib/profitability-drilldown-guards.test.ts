import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The drill-downs show the same margins/costs as /rapports/profitabilite — same guards. */
const PAGES = [
  "src/app/(protected)/rapports/profitabilite/page.tsx",
  "src/app/(protected)/rapports/profitabilite/produit/[productId]/page.tsx",
  "src/app/(protected)/rapports/profitabilite/campagne/[campaignId]/page.tsx",
];

describe("profitability report guards", () => {
  for (const page of PAGES) {
    it(page, () => {
      const src = readFileSync(page, "utf8");
      expect(src).toContain('requirePermission("analytics.view")');
      expect(src).toContain('requirePermission("finance.view")');
      expect(src).toContain('requireChannelKind(viewer, "ONLINE")');
    });
  }
});
