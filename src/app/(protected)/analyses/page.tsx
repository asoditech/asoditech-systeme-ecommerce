import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SalesChart } from "@/components/reports/sales-chart";
import { AnalyticsNav } from "@/components/analytics/analytics-nav";
import { AnalyticsFilterBar, type AnalyticsFilterControl } from "@/components/analytics/analytics-filter-bar";
import { FunnelBars } from "@/components/analytics/funnel-bars";
import { SeriesChart } from "@/components/analytics/series-chart";
import { MetricDefinitions } from "@/components/analytics/metric-definitions";
import {
  LineChart,
  ShoppingCart,
  CheckCircle2,
  Percent,
  PackageCheck,
  Ban,
  TriangleAlert,
  Undo2,
  Wallet,
  Truck,
  Receipt,
  Boxes,
  HandCoins,
  Store,
  PackageMinus,
  TrendingUp,
  TrendingDown,
  ReceiptText,
} from "lucide-react";
import { analyticsContext } from "@/lib/analytics/context";
import { meaningfulDelta } from "@/lib/analytics/period";
import { analyticsQuery, SOURCE_KEYS, sourceLabel } from "@/lib/analytics/filters";
import { formatPct } from "@/lib/analytics/format";
import { getOnlineOverview, getOnlineRevenueSeries, getOnlineFilterOptions } from "@/lib/analytics/queries/online";
import { getOnlineProductPerformance } from "@/lib/analytics/queries/products";
import { getCommissionAnalytics } from "@/lib/analytics/queries/commissions";
import { getStoreOverview, getStoreFilterOptions } from "@/lib/analytics/queries/store";
import { computePeriodProfitability } from "@/lib/profitability";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Analyses — ASODITECH Gestion E-commerce" };

const trendOf = (delta: number | null) =>
  delta === null
    ? undefined
    : { direction: delta > 0 ? ("up" as const) : delta < 0 ? ("down" as const) : ("flat" as const), label: `${delta > 0 ? "+" : ""}${delta} % vs période précédente` };

/**
 * Analytics — overview (docs/adr/0051). Every group is computed only when
 * the viewer may read it (`AnalyticsAccess`): Online order KPIs need an
 * ONLINE channel, store KPIs an OFFLINE channel (rows scoped to the viewer's
 * stores AND locations), commissions `commissions.view`, and cost / margin /
 * profit `finance.view` — never computed without it.
 */
export default async function AnalysesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await analyticsContext(await searchParams, "overview");
  const { access, period, filters, user } = ctx;
  // The P&L is Finance's own function, filterable by store source only —
  // never shown under a filter it cannot honour.
  const pnlSource = filters.source === "WOOCOMMERCE" || filters.source === "SHOPIFY" ? filters.source : filters.source ? null : undefined;
  const pnlAllowed = access.finance && access.online && pnlSource !== null && !filters.onlineChannelId;

  const [online, previous, series, products, commissions, store, pnl, onlineOptions, storeOptions] = await Promise.all([
    access.online ? getOnlineOverview(period.range, filters) : null,
    access.online ? getOnlineOverview(period.previous, filters) : null,
    access.online ? getOnlineRevenueSeries(period, filters) : null,
    access.online ? getOnlineProductPerformance(period.range, filters, { withFinance: false }) : null,
    access.commissions ? getCommissionAnalytics(period, filters) : null,
    access.store ? getStoreOverview(user, period, filters) : null,
    pnlAllowed ? computePeriodProfitability(period.range, pnlSource) : null,
    access.online ? getOnlineFilterOptions() : null,
    access.store ? getStoreFilterOptions(user) : null,
  ]);

  const controls: AnalyticsFilterControl[] = [];
  if (onlineOptions) {
    controls.push({ paramKey: "source", value: filters.source, allLabel: "Toutes les origines", options: SOURCE_KEYS.map((k) => ({ value: k, label: sourceLabel(k) })) });
    if (onlineOptions.onlineChannels.length > 1)
      controls.push({ paramKey: "canal", value: filters.onlineChannelId, allLabel: "Tous les canaux en ligne", options: onlineOptions.onlineChannels.map((c) => ({ value: c.id, label: c.name })) });
  }
  if (storeOptions) {
    controls.push({ paramKey: "magasin", value: filters.storeChannelId, allLabel: "Tous mes magasins", options: storeOptions.storeChannels.map((c) => ({ value: c.id, label: c.name })) });
    controls.push({ paramKey: "emplacement", value: filters.warehouseId, allLabel: "Tous mes emplacements", options: storeOptions.warehouses.map((w) => ({ value: w.id, label: w.name })) });
  }

  const nothing =
    (online?.orders ?? 0) === 0 && (store?.report.salesCount ?? 0) === 0 && (commissions?.earnedCount ?? 0) + (commissions?.reversedCount ?? 0) === 0;
  const pop = online && previous ? { current: online.orders, previous: previous.orders } : { current: 0, previous: 0 };

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses" description={`Indicateurs factuels — ${period.label}. Chaque chiffre est défini en bas de page (population, date, calcul).`} />
      <AnalyticsNav access={access} active="overview" query={ctx.periodQuery} />
      <AnalyticsFilterBar
        basePath="/analyses"
        period={period}
        filterParams={ctx.filterParams}
        controls={controls}
        exportHref={access.online ? `/analyses/export/revenus?${analyticsQuery(period, filters)}` : undefined}
      />

      {nothing ? (
        <EmptyState icon={LineChart} title="Aucune activité sur la période." description="Changez la période ou les filtres pour afficher des données." />
      ) : (
        <>
          {online && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Activité en ligne — commandes passées sur la période</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard label="Commandes en ligne" value={String(online.orders)} icon={ShoppingCart} trend={trendOf(meaningfulDelta(online.orders, previous!.orders, pop))} hint={`${online.pending} encore à confirmer`} />
                <KpiCard label="Commandes confirmées" value={String(online.confirmed)} icon={CheckCircle2} tone="success" />
                <KpiCard label="Taux de confirmation" value={online.confirmationRate === null ? null : formatPct(online.confirmationRate)} unavailableReason="Aucune commande" icon={Percent} tone="info" />
                <KpiCard label="Commandes livrées" value={String(online.delivered)} icon={PackageCheck} tone="success" hint={`sur ${online.shipped} expédiées`} />
                <KpiCard label="Taux de livraison" value={online.deliveryRate === null ? null : formatPct(online.deliveryRate)} unavailableReason="Aucune expédition" icon={Truck} tone="info" />
                <KpiCard label="Annulées" value={String(online.cancelled)} icon={Ban} tone="warning" />
                <KpiCard label="Échecs de livraison" value={String(online.failed)} icon={TriangleAlert} tone="danger" />
                <KpiCard label="Retournées" value={String(online.returned)} icon={Undo2} tone="danger" hint="Retour + Remboursée" />
              </div>

              <h2 className="pt-2 text-sm font-medium text-muted-foreground">Chiffre d&apos;affaires en ligne</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <KpiCard label="CA commandé" value={formatCurrency(online.placedRevenue)} icon={Wallet} trend={trendOf(meaningfulDelta(online.placedRevenue, previous!.placedRevenue, pop))} hint="Hors annulées, échecs, retours" />
                <KpiCard label="CA livré" value={formatCurrency(online.deliveredRevenue)} icon={PackageCheck} tone="success" hint="Commandes de la période livrées" />
                <KpiCard label="Panier moyen" value={online.averageOrderValue === null ? null : formatCurrency(online.averageOrderValue)} unavailableReason="Aucune commande" icon={Receipt} tone="info" />
                <KpiCard label="Unités vendues" value={String(online.unitsSold)} icon={Boxes} tone="violet" />
                <KpiCard label="Remboursé" value={formatCurrency(online.refundedAmount)} icon={Undo2} tone="danger" hint={`Valeur retournée : ${formatCurrency(online.returnedValue)}`} />
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle>CA commandé et commandes — {period.label}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <SalesChart data={series!} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Entonnoir des commandes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <FunnelBars
                      steps={[
                        { label: "Passées", count: online.orders },
                        { label: "Confirmées", count: online.confirmed },
                        { label: "Expédiées", count: online.shipped },
                        { label: "Livrées", count: online.delivered, hint: "Statut actuel" },
                      ]}
                    />
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Produits les plus vendus en ligne</CardTitle>
                </CardHeader>
                <CardContent>
                  {products!.rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Aucune vente sur la période.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Produit</TableHead>
                          <TableHead className="text-right">Unités</TableHead>
                          <TableHead className="text-right">Commandes</TableHead>
                          <TableHead className="text-right">CA</TableHead>
                          <TableHead className="text-right">Unités retournées</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {products!.rows.slice(0, 5).map((p) => (
                          <TableRow key={p.key}>
                            <TableCell className="font-medium">
                              {p.name}
                              {p.variant && <span className="ml-1 text-muted-foreground">— {p.variant}</span>}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{p.units}</TableCell>
                            <TableCell className="text-right tabular-nums">{p.orders}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatCurrency(p.revenue)}</TableCell>
                            <TableCell className="text-right tabular-nums">{p.returnedUnits}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">
                    <Link href={`/analyses/produits?${analyticsQuery(period, filters)}`} className="hover:underline">
                      Voir la performance de tous les produits →
                    </Link>
                  </p>
                </CardContent>
              </Card>
            </section>
          )}

          {commissions && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Commissions — écritures de la période</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <KpiCard label="Commissions gagnées" value={formatCurrency(commissions.earned)} icon={HandCoins} tone="success" hint={`${commissions.earnedCount} commande(s) livrée(s)`} />
                <KpiCard label="Commissions annulées" value={formatCurrency(commissions.reversed)} icon={Undo2} tone="danger" hint={`${commissions.reversedCount} écriture(s)`} />
                <KpiCard label="Commissions nettes" value={formatCurrency(commissions.net)} icon={Wallet} tone="primary" />
              </div>
            </section>
          )}

          {access.finance && access.online && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Rentabilité (Finance)</h2>
              {pnl ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <KpiCard label="Coût des marchandises" value={pnl.cogsComplete ? formatCurrency(pnl.cogs!) : null} unavailableReason="Coût manquant" icon={PackageMinus} tone="warning" />
                  <KpiCard
                    label="Bénéfice brut"
                    value={pnl.grossProfit !== null ? formatCurrency(pnl.grossProfit) : null}
                    unavailableReason="Non calculable"
                    hint={pnl.grossMarginPct !== null ? `Marge ${pnl.grossMarginPct.toFixed(1)} %` : undefined}
                    icon={TrendingUp}
                    tone="success"
                  />
                  <KpiCard
                    label="Bénéfice net"
                    value={pnl.netProfit !== null ? formatCurrency(pnl.netProfit) : null}
                    unavailableReason="Non calculable"
                    hint={pnl.netMarginPct !== null ? `Marge ${pnl.netMarginPct.toFixed(1)} %` : undefined}
                    icon={TrendingDown}
                    tone="violet"
                  />
                  <KpiCard label="Dépenses enregistrées" value={formatCurrency(pnl.expensesTotal)} hint="Déjà déduites du bénéfice net" icon={ReceiptText} tone="danger" />
                  <KpiCard label="Coût de livraison" value={formatCurrency(pnl.deliveryCostTotal)} hint="Déjà déduit du bénéfice net" icon={Truck} tone="info" />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  La rentabilité suit la définition de Finance, filtrable par boutique (WooCommerce / Shopify) uniquement — retirez le filtre d&apos;origine ou de canal pour l&apos;afficher.
                </p>
              )}
            </section>
          )}

          {store && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Ventes en magasin — vos magasins et emplacements</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <KpiCard label="Ventes" value={String(store.report.salesCount)} icon={Store} hint={`${store.report.unitsSold} unité(s)`} />
                <KpiCard label="CA brut magasin" value={formatCurrency(store.report.grossSales)} icon={Wallet} tone="success" />
                <KpiCard label="Remboursements" value={formatCurrency(store.report.refunds)} icon={Undo2} tone="danger" hint="Retours reçus sur la période" />
                <KpiCard label="CA net magasin" value={formatCurrency(store.report.netSales)} icon={Wallet} tone="primary" />
                <KpiCard label="Ticket moyen" value={store.averageSaleValue === null ? null : formatCurrency(store.averageSaleValue)} unavailableReason="Aucune vente" icon={Receipt} tone="info" />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle>CA brut magasin — {period.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <SeriesChart data={store.series} series={[{ key: "revenue", label: "CA brut magasin", color: "var(--color-primary)" }]} currency />
                </CardContent>
              </Card>
            </section>
          )}
        </>
      )}

      <MetricDefinitions section="overview" />
    </div>
  );
}
