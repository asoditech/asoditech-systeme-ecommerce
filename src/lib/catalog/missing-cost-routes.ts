/**
 * Where the « coût d'achat manquant » banner (MissingCostBanner) is shown:
 * every page whose figures — margins, cost of goods, stock value, profit,
 * cash out — are incomplete while a sellable unit has no purchase cost.
 *
 * Each of these pages renders `<MissingCostBanner user={…} />` exactly once,
 * right under its header; no other page renders it. The banner itself checks
 * `finance.view` (and the dashboard keeps its own online-channel condition),
 * so listing a page here never widens who sees it. Enforced by
 * tests/lib/missing-cost-banner-routes.test.ts against the real route tree.
 *
 * Per page rather than in the shared layout on purpose: the layout cannot
 * know the current route on the server, and rendering it there would run the
 * count on every page of the app instead of only these.
 */
export const MISSING_COST_BANNER_ROUTES = [
  "/tableau-de-bord",
  "/produits",
  "/integrations",
  "/stock",
  "/finance",
  "/analyses",
  "/analyses/produits",
  "/rapports",
  "/rapports/profitabilite",
  "/rapports/rentabilite",
  "/rapports/stock",
  "/rapports/tresorerie",
] as const;

/** Link target of the banner — the products list filtered on « coût manquant ». */
export const MISSING_COST_PRODUCTS_HREF = "/produits?cout=manquant";
