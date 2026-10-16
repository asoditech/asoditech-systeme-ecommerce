import Link from "next/link";
import { CHART_COLORS } from "@/lib/design/chart";
import { PageHeader } from "@/components/page-header";
import { MissingCostBanner } from "@/components/catalog-health/missing-cost-banner";
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
import { AnalyticsMetricInfo } from "@/components/analytics/analytics-metric-info";
import { ScopeBlockedNotice } from "@/components/analytics/scope-blocked-notice";
import { Notice } from "@/components/ui/notice";
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
import { hasScopeFilter, isBlocked, onlineScopeLabel, pnlSourceOf, scopeControls, storeScopeLabel } from "@/lib/analytics/scope";
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
  // Requirement A — one scope for the whole page (src/lib/analytics/scope.ts):
  // a section is computed only when it can honour EVERY active filter.
  // Online orders, commissions and the Finance P&L have no store / location
  // (ADR 0050/0051; `Expense` has no store column); a POS sale has no Online
  // origin / channel. A section that cannot honour the filters is not
  // computed and is replaced by an explicit « non filtrable » notice.
  const showOnline = access.online && !isBlocked("online", filters);
  const showCommissions = access.commissions && !isBlocked("commissions", filters);
  const showPnl = access.finance && access.online && !isBlocked("pnl", filters);
  const showStore = access.store && !isBlocked("store", filters);
  const pnlSource = pnlSourceOf(filters) ?? undefined;

  const [online, previous, series, products, commissions, store, pnl, onlineOptions, storeOptions] = await Promise.all([
    showOnline ? getOnlineOverview(period.range, filters) : null,
    showOnline ? getOnlineOverview(period.previous, filters) : null,
    showOnline ? getOnlineRevenueSeries(period, filters) : null,
    showOnline ? getOnlineProductPerformance(period.range, filters, { withFinance: false }) : null,
    showCommissions ? getCommissionAnalytics(period, filters) : null,
    showStore ? getStoreOverview(user, period, filters) : null,
    showPnl ? computePeriodProfitability(period.range, pnlSource) : null,
    access.online ? getOnlineFilterOptions() : null,
    access.store ? getStoreFilterOptions(user) : null,
  ]);

  const controls: AnalyticsFilterControl[] = scopeControls(
    filters,
    onlineOptions ? { sources: SOURCE_KEYS.map((k) => ({ value: k, label: sourceLabel(k) })), onlineChannels: onlineOptions.onlineChannels } : null,
    storeOptions
  );
  const onlineScope = onlineScopeLabel(filters, sourceLabel, new Map((onlineOptions?.onlineChannels ?? []).map((c) => [c.id, c.name])));
  const storeScope = storeOptions
    ? storeScopeLabel(filters, { stores: new Map(storeOptions.storeChannels.map((c) => [c.id, c.name])), warehouses: new Map(storeOptions.warehouses.map((w) => [w.id, w.name])) })
    : "";

  // Zero everywhere: the generic empty state only when NO scope filter is set;
  // under a filter the sections render their genuine zeros (an empty store
  // shows 0, never the previous / all-store figures).
  const allZero =
    (online?.orders ?? 0) === 0 && (store?.report.salesCount ?? 0) === 0 && (commissions?.earnedCount ?? 0) + (commissions?.reversedCount ?? 0) === 0 && (pnl?.ordersCount ?? 0) === 0;
  const filtered = hasScopeFilter(filters);
  const nothing = allZero && !filtered;
  const exportHref = showOnline
    ? `/analyses/export/revenus?${analyticsQuery(period, filters)}`
    : showStore
      ? `/analyses/export/canaux?${analyticsQuery(period, filters)}`
      : undefined;
  const blockedNotice = (block: "online" | "commissions" | "pnl" | "store", title: string) => (
    <ScopeBlockedNotice block={block} title={title} basePath="/analyses" period={period} filters={filters} />
  );
  const pop = online && previous ? { current: online.orders, previous: previous.orders } : { current: 0, previous: 0 };

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses" description={`Indicateurs factuels — ${period.label}. Chaque chiffre est défini en bas de page (population, date, calcul).`} />
      <AnalyticsNav access={access} active="overview" query={ctx.periodQuery} />
      <MissingCostBanner user={user} />
      <AnalyticsFilterBar
        basePath="/analyses"
        period={period}
        filterParams={ctx.filterParams}
        controls={controls}
        exportHref={exportHref}
      />

      {nothing ? (
        <EmptyState icon={LineChart} title="Aucune activité sur la période." description="Changez la période ou les filtres pour afficher des données." />
      ) : (
        <>
          {filtered && allZero && (
            <Notice tone="neutral" size="sm">
              Aucune activité pour cette sélection sur la période — les chiffres ci-dessous sont de vrais zéros.
            </Notice>
          )}
          {access.online && !showOnline && blockedNotice("online", "Activité en ligne")}
          {online && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Activité en ligne — commandes passées sur la période · {onlineScope}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard label="Commandes en ligne" metric="ordersPlaced" value={String(online.orders)} icon={ShoppingCart} trend={trendOf(meaningfulDelta(online.orders, previous!.orders, pop))} hint={`${online.pending} encore à confirmer`} />
                <KpiCard label="Commandes confirmées" metric="confirmedOrders" value={String(online.confirmed)} icon={CheckCircle2} tone="success" />
                <KpiCard label="Taux de confirmation" metric="confirmationRate" value={online.confirmationRate === null ? null : formatPct(online.confirmationRate)} unavailableReason="Aucune commande appelée" icon={Percent} tone="info" hint={`sur ${online.wentThroughConfirmation} appelée(s)`} />
                <KpiCard label="Commandes livrées" metric="deliveredOrders" value={String(online.delivered)} icon={PackageCheck} tone="success" hint={`sur ${online.shipped} expédiées`} />
                <KpiCard label="Taux de livraison réussie" metric="deliveryRate" value={online.deliveryRate === null ? null : formatPct(online.deliveryRate)} unavailableReason="Aucune livraison terminée" icon={Truck} tone="info" />
                <KpiCard label="Annulées" metric="cancelledOrders" value={String(online.cancelled)} icon={Ban} tone="warning" />
                <KpiCard label="Échecs de livraison" metric="failedDeliveries" value={String(online.failed)} icon={TriangleAlert} tone="danger" />
                <KpiCard label="Retournées" metric="returnedOrders" value={String(online.returned)} icon={Undo2} tone="danger" hint="Colis retourné, ou commande Retour / Remboursée" />
              </div>

              <h2 className="pt-2 text-sm font-medium text-muted-foreground">Chiffre d&apos;affaires en ligne</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <KpiCard label="Chiffre d'affaires" metric="netRevenue" value={formatCurrency(online.netRevenue)} icon={Wallet} trend={trendOf(meaningfulDelta(online.netRevenue, previous!.netRevenue, pop))} hint={`Brut ${formatCurrency(online.placedRevenue)}, remboursements déduits`} />
                <KpiCard label="CA livré" metric="deliveredRevenue" value={formatCurrency(online.deliveredRevenue)} icon={PackageCheck} tone="success" hint="Commandes de la période livrées" />
                <KpiCard label="Panier moyen" metric="averageBasket" value={online.averageOrderValue === null ? null : formatCurrency(online.averageOrderValue)} unavailableReason="Aucune commande" icon={Receipt} tone="info" />
                <KpiCard label="Unités vendues" metric="unitsSold" value={String(online.unitsSold)} icon={Boxes} tone="violet" />
                <KpiCard label="Remboursé" metric="refunded" value={formatCurrency(online.refundedAmount)} icon={Undo2} tone="danger" hint={`Valeur retournée : ${formatCurrency(online.returnedValue)}`} />
              </div>

              <div className="grid gap-6 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <CardHeader>
                    <CardTitle accent="green">
                Chiffre d&apos;affaires et commandes — {period.label}
                <AnalyticsMetricInfo metric="revenueOrdersChart" />
              </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <SalesChart data={series!} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle accent="green">
                Entonnoir des commandes
                <AnalyticsMetricInfo metric="orderFunnel" />
              </CardTitle>
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
                  <CardTitle accent="green">
                Produits les plus vendus en ligne
                <AnalyticsMetricInfo metric="topProducts" />
              </CardTitle>
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

          {access.commissions && !showCommissions && blockedNotice("commissions", "Commissions")}
          {commissions && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Commissions — écritures de la période · {onlineScope}</h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <KpiCard label="Commissions gagnées" metric="commissionsEarned" value={formatCurrency(commissions.earned)} icon={HandCoins} tone="success" hint={`${commissions.earnedCount} commande(s) livrée(s)`} />
                <KpiCard label="Commissions annulées" metric="commissionsReversed" value={formatCurrency(commissions.reversed)} icon={Undo2} tone="danger" hint={`${commissions.reversedCount} écriture(s)`} />
                <KpiCard label="Commissions nettes" metric="commissionsNet" value={formatCurrency(commissions.net)} icon={Wallet} tone="primary" />
              </div>
            </section>
          )}

          {access.finance && access.online && !showPnl && blockedNotice("pnl", "Rentabilité (Finance)")}
          {pnl && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Rentabilité (Finance) — commandes en ligne{pnlSource ? ` ${sourceLabel(pnlSource)}` : ""} ; dépenses : toutes celles du compte (non rattachées à une boutique ni à un magasin)
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <KpiCard label="Coût des marchandises" metric="cogs" value={pnl.cogsComplete ? formatCurrency(pnl.cogs!) : null} unavailableReason="Coût manquant" icon={PackageMinus} tone="warning" />
                  <KpiCard
                    label="Bénéfice brut"
                    metric="grossProfit"
                    value={pnl.grossProfit !== null ? formatCurrency(pnl.grossProfit) : null}
                    unavailableReason="Non calculable"
                    hint={pnl.grossMarginPct !== null ? `Marge ${pnl.grossMarginPct.toFixed(1)} %` : undefined}
                    icon={TrendingUp}
                    tone="success"
                  />
                  <KpiCard
                    label="Bénéfice net"
                    metric="netProfit"
                    value={pnl.netProfit !== null ? formatCurrency(pnl.netProfit) : null}
                    unavailableReason="Non calculable"
                    hint={pnl.netMarginPct !== null ? `Marge ${pnl.netMarginPct.toFixed(1)} %` : undefined}
                    icon={TrendingDown}
                    tone="violet"
                  />
                  <KpiCard label="Dépenses enregistrées" metric="expenses" value={formatCurrency(pnl.expensesTotal)} hint="Déjà déduites du bénéfice net" icon={ReceiptText} tone="danger" />
                  <KpiCard label="Coût de livraison" metric="deliveryCost" value={formatCurrency(pnl.deliveryCostTotal)} hint="Déjà déduit du bénéfice net" icon={Truck} tone="info" />
              </div>
            </section>
          )}

          {access.store && !showStore && blockedNotice("store", "Ventes en magasin")}
          {store && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Ventes en magasin — {storeScope}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <KpiCard label="Ventes" metric="storeSales" value={String(store.report.salesCount)} icon={Store} hint={`${store.report.unitsSold} unité(s)`} />
                <KpiCard label="CA brut magasin" metric="storeGrossSales" value={formatCurrency(store.report.grossSales)} icon={Wallet} tone="success" />
                <KpiCard label="Remboursements" metric="storeRefunds" value={formatCurrency(store.report.refunds)} icon={Undo2} tone="danger" hint="Retours reçus sur la période" />
                <KpiCard label="CA net magasin" metric="storeNetSales" value={formatCurrency(store.report.netSales)} icon={Wallet} tone="primary" />
                <KpiCard label="Ticket moyen" metric="storeAverageTicket" value={store.averageSaleValue === null ? null : formatCurrency(store.averageSaleValue)} unavailableReason="Aucune vente" icon={Receipt} tone="info" />
              </div>
              <Card>
                <CardHeader>
                  <CardTitle accent="green">
                CA brut magasin — {period.label}
                <AnalyticsMetricInfo metric="storeGrossSales" />
              </CardTitle>
                </CardHeader>
                <CardContent>
                  <SeriesChart data={store.series} series={[{ key: "revenue", label: "CA brut magasin", color: CHART_COLORS.brand }]} currency />
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
