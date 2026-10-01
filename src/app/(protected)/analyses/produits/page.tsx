import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnalyticsNav } from "@/components/analytics/analytics-nav";
import { AnalyticsFilterBar, type AnalyticsFilterControl } from "@/components/analytics/analytics-filter-bar";
import { ProductPerformanceTable, CategoryPerformanceTable } from "@/components/analytics/product-performance-table";
import { MetricDefinitions } from "@/components/analytics/metric-definitions";
import { analyticsContext } from "@/lib/analytics/context";
import { analyticsQuery, SOURCE_KEYS, sortRows, sourceLabel } from "@/lib/analytics/filters";
import { getOnlineProductPerformance, getStoreProductPerformance, type ProductRow } from "@/lib/analytics/queries/products";
import { getStoreFilterOptions } from "@/lib/analytics/queries/store";
import { prisma } from "@/lib/prisma";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Analyses — Produits — ASODITECH Gestion E-commerce" };

const PRODUCT_COLUMNS = {
  name: (r: ProductRow) => r.name.toLowerCase(),
  units: (r: ProductRow) => r.units,
  orders: (r: ProductRow) => r.orders,
  revenue: (r: ProductRow) => r.revenue,
  returns: (r: ProductRow) => r.returnedUnits,
};

/**
 * Product performance (docs/adr/0051) — Online and store in SEPARATE tables
 * (an in-store sale is never an Online order). Cost and gross profit are
 * computed by the query only with `finance.view`.
 */
export default async function ProductAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await analyticsContext(await searchParams, "products");
  const { access, period, filters, user } = ctx;
  const withFinance = access.finance;
  const [online, store, categories, storeOptions] = await Promise.all([
    access.online ? getOnlineProductPerformance(period.range, filters, { withFinance }) : null,
    access.store ? getStoreProductPerformance(user, period.range, filters, { withFinance }) : null,
    prisma.category.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    access.store ? getStoreFilterOptions(user) : null,
  ]);

  const controls: AnalyticsFilterControl[] = [{ paramKey: "categorie", value: filters.categoryId, allLabel: "Toutes les catégories", options: categories.map((c) => ({ value: c.id, label: c.name })) }];
  if (access.online) controls.unshift({ paramKey: "source", value: filters.source, allLabel: "Toutes les origines", options: SOURCE_KEYS.map((k) => ({ value: k, label: sourceLabel(k) })) });
  if (storeOptions) {
    controls.push({ paramKey: "magasin", value: filters.storeChannelId, allLabel: "Tous mes magasins", options: storeOptions.storeChannels.map((c) => ({ value: c.id, label: c.name })) });
    controls.push({ paramKey: "emplacement", value: filters.warehouseId, allLabel: "Tous mes emplacements", options: storeOptions.warehouses.map((w) => ({ value: w.id, label: w.name })) });
  }
  const sortKey = filters.sort && filters.sort in PRODUCT_COLUMNS ? filters.sort : "units";
  const sort = { basePath: "/analyses/produits", params: ctx.params, key: sortKey, dir: filters.dir ?? ("desc" as const) };

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses — Produits" description={`Unités, commandes, chiffre d'affaires et retours par produit et variation — ${period.label}.`} />
      <AnalyticsNav access={access} active="products" query={ctx.periodQuery} />
      <AnalyticsFilterBar basePath="/analyses/produits" period={period} filterParams={ctx.filterParams} controls={controls} exportHref={`/analyses/export/produits?${analyticsQuery(period, filters)}`} />

      {online && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>En ligne — par produit et variation</CardTitle>
              <p className="text-xs text-muted-foreground">
                {online.totals.units} unité(s) · {formatCurrency(online.totals.revenue)} · {online.totals.returnedUnits} unité(s) retournée(s) reçue(s) sur la période
              </p>
            </CardHeader>
            <CardContent>
              {online.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune vente en ligne sur la période.</p>
              ) : (
                <ProductPerformanceTable rows={sortRows(online.rows, filters, PRODUCT_COLUMNS, "units")} parentLabel="Commandes" sort={sort} />
              )}
            </CardContent>
          </Card>
          {online.categories.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>En ligne — par catégorie</CardTitle>
              </CardHeader>
              <CardContent>
                <CategoryPerformanceTable rows={online.categories} parentLabel="Commandes" />
              </CardContent>
            </Card>
          )}
        </>
      )}

      {store && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Magasin — par produit et variation</CardTitle>
              <p className="text-xs text-muted-foreground">
                Vos magasins et emplacements uniquement · {store.totals.units} unité(s) · {formatCurrency(store.totals.revenue)}
              </p>
            </CardHeader>
            <CardContent>
              {store.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune vente en magasin sur la période.</p>
              ) : (
                <ProductPerformanceTable rows={sortRows(store.rows, filters, PRODUCT_COLUMNS, "units")} parentLabel="Ventes" sort={sort} />
              )}
            </CardContent>
          </Card>
          {store.categories.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Magasin — par catégorie</CardTitle>
              </CardHeader>
              <CardContent>
                <CategoryPerformanceTable rows={store.categories} parentLabel="Ventes" />
              </CardContent>
            </Card>
          )}
        </>
      )}

      <MetricDefinitions section="products" />
    </div>
  );
}
