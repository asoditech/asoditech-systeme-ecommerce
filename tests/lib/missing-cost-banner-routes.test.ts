import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MISSING_COST_BANNER_ROUTES, MISSING_COST_PRODUCTS_HREF } from "@/lib/catalog/missing-cost-routes";

const summary = vi.fn();
vi.mock("@/lib/queries/missing-cost", () => ({ getMissingCostSummary: () => summary() }));
const { MissingCostBanner } = await import("@/components/catalog-health/missing-cost-banner");

/**
 * « Coût d'achat manquant » banner placement: the explicit route list is the
 * single policy, checked against the real app route tree — every listed page
 * renders the banner exactly once, no other page renders it. The count
 * itself (and its tenant scoping) is covered by tests/lib/missing-cost.test.ts.
 */

const APP = join(process.cwd(), "src/app");
const PROTECTED = join(APP, "(protected)");
const pageFile = (route: string) => join(PROTECTED, ...route.split("/").filter(Boolean), "page.tsx");
const allPages = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allPages(join(dir, d.name)) : d.name === "page.tsx" ? [join(dir, d.name)] : []
  );
const bannerCount = (file: string) => (readFileSync(file, "utf8").match(/<MissingCostBanner\b/g) ?? []).length;

describe("route policy", () => {
  it("every listed route is a real page that renders the banner exactly once (no duplicate)", () => {
    for (const route of MISSING_COST_BANNER_ROUTES) {
      const file = pageFile(route);
      expect(existsSync(file), route).toBe(true);
      expect(bannerCount(file), route).toBe(1);
    }
  });

  it("covers the cost-dependent pages: reports (profitability, margin, stock, cash), finance, analyses, stock", () => {
    expect(MISSING_COST_BANNER_ROUTES).toEqual(
      expect.arrayContaining([
        "/rapports", "/rapports/profitabilite", "/rapports/rentabilite", "/rapports/stock", "/rapports/tresorerie",
        "/finance", "/analyses", "/analyses/produits", "/stock", "/produits", "/integrations", "/tableau-de-bord",
      ])
    );
  });

  it("no page outside the list renders it", () => {
    const listed = new Set(MISSING_COST_BANNER_ROUTES.map(pageFile));
    const offenders = allPages(APP)
      .filter((f) => !listed.has(f) && bannerCount(f) > 0)
      .map((f) => relative(process.cwd(), f).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("the dashboard keeps its extra online-channel condition", () => {
    const dashboard = readFileSync(pageFile("/tableau-de-bord"), "utf8");
    expect(dashboard).toMatch(/\{canViewFinance && <MissingCostBanner user=\{user\} \/>\}/);
    expect(dashboard).toMatch(/canViewFinance = userHasPermission\(user, "finance\.view"\) && user\.channels\.online/);
  });
});

describe("MissingCostBanner", () => {
  beforeEach(() => {
    summary.mockReset();
    summary.mockResolvedValue({ units: 3, products: 2, bySource: { INTERNE: 1, WOOCOMMERCE: 2, SHOPIFY: 0 } });
  });

  it("without finance.view: renders nothing and never reads the count", async () => {
    expect(await MissingCostBanner({ user: { permissions: new Set(["products.view", "analytics.view", "inventory.view"] as const) } })).toBeNull();
    expect(summary).not.toHaveBeenCalled();
  });

  it("with finance.view: the warning, its per-source detail and the link to the « coût manquant » product filter", async () => {
    const html = renderToStaticMarkup((await MissingCostBanner({ user: { permissions: new Set(["finance.view"] as const) } }))!);
    expect(summary).toHaveBeenCalledTimes(1);
    expect(html).toContain("3 produit(s)/variante(s) sans coût d&#x27;achat");
    expect(html).toContain("1 créés ici · 2 WooCommerce");
    expect(html).toContain(`href="${MISSING_COST_PRODUCTS_HREF.replace("&", "&amp;")}"`);
    expect(MISSING_COST_PRODUCTS_HREF).toBe("/produits?cout=manquant");
    expect(html).toContain("print:hidden"); // reports are printed to PDF — the banner is screen-only
  });

  it("the link's filter is the one the products page actually reads", () => {
    expect(readFileSync(pageFile("/produits"), "utf8")).toContain('params.cout === "manquant"');
  });

  it("nothing to show once every cost is entered", async () => {
    summary.mockResolvedValue({ units: 0, products: 0, bySource: { INTERNE: 0, WOOCOMMERCE: 0, SHOPIFY: 0 } });
    expect(await MissingCostBanner({ user: { permissions: new Set(["finance.view"] as const) } })).toBeNull();
  });
});
