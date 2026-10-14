import { customerVisibilityWhere } from "@/lib/customers/visibility";
import Link from "next/link";
import {
  ShoppingCart,
  Boxes,
  Trophy,
  ArrowRight,
  Wallet,
  TrendingUp,
  Users,
  Truck,
  Receipt,
  ShoppingBag,
  PhoneCall,
  CheckCircle2,
  RotateCcw,
  Store,
  LayoutGrid,
  LineChart,
  Package2,
  Activity,
  AlertCircle,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { MissingCostBanner } from "@/components/catalog-health/missing-cost-banner";
import { KpiCard } from "@/components/kpi-card";
import { SummarySection } from "@/components/summary-section";
import { MetricBreakdown } from "@/components/metric-breakdown";
import { FadeIn } from "@/components/motion/stagger-list";
import { CommandHero } from "@/components/dashboard/command-hero";
import { RevenueTrendChart } from "@/components/dashboard/revenue-trend-chart";
import { TopSellingProducts } from "@/components/dashboard/top-selling-products";
import { DashboardMetricInfo } from "@/components/dashboard/dashboard-metric-info";
import { DashboardDefinitions } from "@/components/dashboard/dashboard-definitions";
import { EmptyState } from "@/components/empty-state";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilterDropdownPill } from "@/components/filter-dropdown-pill";
import { StockDonut } from "@/components/dashboard/stock-donut";
import { CHART_COLORS } from "@/lib/design/chart";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { landingPathFor } from "@/lib/auth/landing";
import { userHasPermission } from "@/lib/auth/permissions";
import { auditScopeWhere } from "@/lib/auth/audit-scope";
import { getChannelReport, combinedChannelRevenue } from "@/lib/queries/reports/channels";
import {
  getDashboardData,
  getRevenueTrend,
  DASHBOARD_PERIOD_LABELS,
  REVENUE_TREND_LABELS,
  isDashboardPeriod,
  type DashboardPeriod,
  type RevenueTrendRange,
} from "@/lib/queries/dashboard";
import { getTopSellingUnits } from "@/lib/queries/analytics";
import { getConfirmationDashboardSummary } from "@/lib/queries/order-confirmation";
import { getCommissionDashboardSummary } from "@/lib/queries/commissions";
import { getStockOverview } from "@/lib/queries/inventory";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { humanizeAuditAction } from "@/lib/audit-labels";
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  displayOrderNumber,
  displayOrderRecipient,
  displayOrderChannel,
} from "@/lib/format";

export const metadata = { title: "Tableau de bord — ASODITECH Gestion E-commerce" };

const PERIOD_SUFFIX: Record<DashboardPeriod, string> = {
  jour: "aujourd'hui",
  hier: "hier",
  mois: "ce mois",
  trimestre: "ce trim.",
  annee: "cette année",
};

function withParam(params: Record<string, string | undefined>, key: string, value: string | undefined) {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v && k !== key) next.set(k, v);
  }
  if (value) next.set(key, value);
  const qs = next.toString();
  return qs ? `/tableau-de-bord?${qs}` : "/tableau-de-bord";
}

function trend(current: number, previous: number) {
  if (previous === 0) return undefined;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return {
    direction: (change > 0.5 ? "up" : change < -0.5 ? "down" : "flat") as "up" | "down" | "flat",
    label: `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
  };
}

interface DashboardOrderRow {
  id: string;
  status: string;
  total: { toString(): string };
  currency: string;
  placedAt: Date;
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  channel: string | null;
  customer: { fullName: string } | null;
  shippingName?: string | null;
  orderNumber: number;
  displayNumber: number | null;
}

/**
 * One scannable order row — Phase 2 UI refinement ("order number,
 * customer, amount, channel, age/date, action" in one glance). Shared by
 * both order lists below so they read as the same list language; the
 * `action` slot is the only thing that differs between them.
 */
function OrderRow({
  order,
  orderNumberPrefix,
  action,
}: {
  order: DashboardOrderRow;
  orderNumberPrefix: string;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-3 text-sm">
      <Link href={`/commandes/${order.id}`} className="min-w-0 flex-1 rounded-lg hover:underline">
        <p className="truncate font-medium text-ink">{displayOrderNumber(order, orderNumberPrefix)}</p>
        <p className="truncate text-xs text-ink-muted">
          {displayOrderRecipient(order)} · {displayOrderChannel(order)} · {formatDate(order.placedAt)}
        </p>
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-semibold text-ink tabular-nums">{formatCurrency(order.total.toString(), order.currency)}</span>
        {action}
      </div>
    </li>
  );
}

/** Online / Offline / Total dashboard filter (Batch 3, Task 5) — same channel
 * semantics as /rapports/canaux (docs/adr/0040): "Total" is only ever a real
 * choice, never a default that a single-channel viewer stumbles into, and is
 * only offered when the viewer may read BOTH (see `canFilterChannel` below). */
type DashboardChannelFilter = "total" | "en-ligne" | "magasin";
const CHANNEL_FILTER_LABELS: Record<DashboardChannelFilter, string> = {
  total: "Tous",
  "en-ligne": "En ligne",
  magasin: "Magasin",
};

export default async function TableauDeBordPage({
  searchParams,
}: {
  searchParams: Promise<{ periode?: string; graphique?: string; canal?: string }>;
}) {
  const user = await requireUser();
  // A real page guard (docs/adr/0050 — G8), not just a hidden nav link. The
  // dashboard is also the post-login landing, so a user without it is
  // forwarded to the first page they may open instead of a dead end.
  if (!userHasPermission(user, "dashboard.view")) redirect(landingPathFor(user));
  const params = await searchParams;
  const periodKey: DashboardPeriod = isDashboardPeriod(params.periode) ? params.periode : "mois";
  const chartRange: RevenueTrendRange =
    params.graphique && REVENUE_TREND_LABELS[params.graphique as RevenueTrendRange]
      ? (params.graphique as RevenueTrendRange)
      : "annee";

  const [data, revenueTrend, business] = await Promise.all([
    getDashboardData(periodKey, undefined, {
      auditScope: auditScopeWhere(user.channels),
      viewer: user,
      customerScope: customerVisibilityWhere(user),
    }),
    getRevenueTrend(chartRange),
    getReportBusinessInfo(),
  ]);
  const suffix = PERIOD_SUFFIX[periodKey];

  const canViewOrders = userHasPermission(user, "orders.view");
  // The finance KPIs and the revenue chart are aggregated from delivery ORDERS
  // (docs/adr/0039): finance.view is a shared permission, so without an
  // ONLINE channel they would leak Online revenue to an Offline-only user.
  // The Online/Offline/Total view is the channel report (docs/adr/0040).
  const canViewFinance = userHasPermission(user, "finance.view") && user.channels.online;
  const canViewInventory = userHasPermission(user, "inventory.view");
  const canViewDelivery = userHasPermission(user, "delivery.view");
  const canViewCustomers = userHasPermission(user, "customers.view");
  const canViewAudit = userHasPermission(user, "audit.view");
  const canConfirm = userHasPermission(user, "orders.confirm");
  const canViewCommissions = userHasPermission(user, "commissions.view");
  // In-store sales KPI (docs/adr/0040) — only for a viewer who may read Offline
  // data, row-scoped to their store channels; it is NEVER folded into the
  // Online figures above, so an Online-only viewer's totals cannot include it.
  // Reuses `data.period` (the SAME periodKey → range resolution
  // `getDashboardData` already did for the Online/finance figures above) so
  // the two KPIs can never drift onto different windows for "the same" period.
  const offlineSummary =
    userHasPermission(user, "sales.view") && user.channels.offline
      ? (await getChannelReport(user, data.period, { kind: "offline" })).offline
      : null;
  const [confirmationSummary, commissionSummary, stockOverview, topSellingUnits] = await Promise.all([
    canConfirm ? getConfirmationDashboardSummary() : Promise.resolve(null),
    canViewCommissions ? getCommissionDashboardSummary() : Promise.resolve(null),
    // Batch 9, Group 10 — operational stock KPI (no monetary valuation:
    // costing/COGS is deferred). Location-scoped through the same
    // `listAccessibleActiveWarehouses` authorization every other
    // location-aware surface already uses — never "all" for a scoped user.
    canViewInventory ? getStockOverview(user) : Promise.resolve(null),
    // "Top Selling Products" (UI refinement pass, 2026-09) — replaces
    // "Livraisons échouées". Same read boundary as the order-derived list
    // cards below (Commandes récentes, Commandes nécessitant une action):
    // gated on orders.view, scoped to the SAME period as the rest of the
    // page via `data.period`.
    canViewOrders ? getTopSellingUnits(data.period, 5) : Promise.resolve([]),
  ]);

  // Only a viewer who can already see BOTH scopes gets a filter at all — a
  // single-channel viewer keeps today's behaviour exactly (no selector, no
  // possible "Total" to bypass their own scope with).
  const canFilterChannel = canViewFinance && offlineSummary !== null;
  const canalKey: DashboardChannelFilter =
    canFilterChannel && (params.canal === "en-ligne" || params.canal === "magasin") ? params.canal : "total";
  const showOnline = !canFilterChannel || canalKey !== "magasin";
  const showOffline = !canFilterChannel || canalKey !== "en-ligne";
  // Strict channel isolation: under « Magasin » every section built from
  // ONLINE orders (confirmation, commissions, delivery rate, best sellers,
  // orders to handle / recent orders) is hidden — never shown as if it were
  // store data. Stock (location-based) and the audit trail stay.
  const showOnlineOps = showOnline;
  // Same formula getChannelReport's own `total` uses (combinedChannelRevenue,
  // src/lib/queries/reports/channels.ts) — reusing the two figures already
  // computed on this same page rather than a second call to that report.
  const totalRevenue =
    canFilterChannel && canalKey === "total" && offlineSummary
      ? combinedChannelRevenue(data.finance.revenue, offlineSummary.netSales)
      : null;
  // "Command Hero" headline (Phase 4) — exactly ONE dominant revenue figure
  // per view: the combined total when both scopes are visible, else the
  // online figure, else (an offline-only viewer) the store net-sales
  // figure. Whichever becomes the headline is skipped from the compact
  // breakdown grid further down, so no number appears twice.
  const showOnlineHeadline = totalRevenue === null && canViewFinance && showOnline;
  const showOfflineHeadline = totalRevenue === null && !showOnlineHeadline && offlineSummary !== null && showOffline;
  const hasHero = totalRevenue !== null || showOnlineHeadline || showOfflineHeadline;
  // The secondary business-volume stats shown INSIDE the hero (never
  // duplicated as separate tiles below) — same permission gates each one
  // always had as a standalone KpiCard, just relocated.
  const heroStats = [
    canViewOrders && showOnline
      ? { label: `Commandes (${suffix})`, value: String(data.ordersPlaced), icon: ShoppingCart, explain: <DashboardMetricInfo metric="ordersPlaced" /> }
      : null,
    canViewFinance && showOnline
      ? {
          label: `Panier moyen (${suffix})`,
          value: data.finance.avgOrderValue !== null ? formatCurrency(data.finance.avgOrderValue) : "—",
          icon: ShoppingBag,
          explain: <DashboardMetricInfo metric="averageBasket" />,
        }
      : null,
    canViewCustomers
      ? { label: `Nouveaux clients (${suffix})`, value: String(data.newCustomersThisPeriod), icon: Users, explain: <DashboardMetricInfo metric="newCustomers" /> }
      : null,
  ].filter((s): s is { label: string; value: string; icon: typeof ShoppingCart; explain: React.ReactElement } => s !== null);

  // Bento layout (Soft UI): the overview card and the « Meilleures ventes »
  // side list share the first row — same condition the list always had.
  const showTopSellers = showOnline && canViewOrders;

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={`Bonjour ${user.name.split(" ")[0]}, voici l'état de votre activité.`}
        actions={
          <FilterDropdownPill
            ariaLabel="Période"
            items={(Object.keys(DASHBOARD_PERIOD_LABELS) as DashboardPeriod[]).map((key) => ({
              key,
              label: DASHBOARD_PERIOD_LABELS[key],
              href: withParam(params, "periode", key === "mois" ? undefined : key),
              active: key === periodKey,
            }))}
          />
        }
      />

      {/* Missing purchase costs make « Bénéfice net » below « Non calculable » — say why, with the fix. */}
      {canViewFinance && <MissingCostBanner user={user} />}

      {canFilterChannel && (
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
          <SegmentedControl>
            {(Object.keys(CHANNEL_FILTER_LABELS) as DashboardChannelFilter[]).map((key) => (
              <SegmentedControlItem key={key} active={key === canalKey} href={withParam(params, "canal", key === "total" ? undefined : key)}>
                {CHANNEL_FILTER_LABELS[key]}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          {canalKey === "magasin" && (
            <p className="text-xs text-ink-muted">
              Vue Magasin : les sections issues des commandes en ligne (confirmation, livraison, meilleures ventes, commandes) sont masquées.
            </p>
          )}
        </div>
      )}

      <SummarySection title="Aperçu" icon={LayoutGrid} className="mb-8">
        <div className={cn("grid items-start gap-5", showTopSellers && "xl:grid-cols-[minmax(0,1fr)_380px]")}>
          <div className="min-w-0 space-y-5">
            {/* "Command Hero" — the large overview card: whichever revenue
                figure is this viewer's headline (combined total, online-only,
                or store-only), plus a real trend sparkline from the exact
                same data already fetched for the chart below, plus the
                secondary business-volume stats. */}
            {totalRevenue !== null && (
              <CommandHero
                eyebrow={`Vue d'ensemble · ${suffix}`}
                label="Chiffre d'affaires total"
                explain={<DashboardMetricInfo metric="totalRevenue" />}
                value={formatCurrency(totalRevenue)}
                hint="En ligne + Magasin net"
                sparklineData={canViewFinance && showOnline ? revenueTrend.map((d) => ({ value: d.revenue })) : undefined}
                stats={heroStats}
              />
            )}
            {showOnlineHeadline && (
              <CommandHero
                eyebrow={`Vue d'ensemble · ${suffix}`}
                label={`Chiffre d'affaires${canFilterChannel ? " en ligne" : ""}`}
                explain={<DashboardMetricInfo metric="revenue" />}
                value={formatCurrency(data.finance.revenue)}
                trend={trend(data.finance.revenue, data.previousFinance.revenue)}
                sparklineData={revenueTrend.map((d) => ({ value: d.revenue }))}
                stats={heroStats}
              />
            )}
            {showOfflineHeadline && offlineSummary && (
              <CommandHero
                eyebrow={`Vue d'ensemble · ${suffix}`}
                label="Ventes magasin nettes"
                explain={<DashboardMetricInfo metric="storeNetSales" />}
                value={formatCurrency(offlineSummary.netSales)}
                hint={`${offlineSummary.salesCount} vente(s) · ${offlineSummary.unitsSold} article(s)`}
                stats={heroStats}
              />
            )}
            {/* No revenue-scope permission at all (a role like Entrepôt/Livraison
                with orders.view/customers.view but neither finance.view nor
                sales.view) — the hero has nothing honest to headline, so every
                figure that would have been a hero stat falls back to its own
                KpiCard instead of silently disappearing. */}
            {!hasHero && heroStats.length > 0 && (
              <FadeIn className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {canViewOrders && showOnline && (
                  <KpiCard size="lg" label={`Commandes (${suffix})`} value={String(data.ordersPlaced)} icon={ShoppingCart} tone="violet" explain={<DashboardMetricInfo metric="ordersPlaced" className="-ml-1" />} />
                )}
                {canViewFinance && showOnline && (
                  <KpiCard
                    size="lg"
                    label={`Panier moyen (${suffix})`}
                    value={data.finance.avgOrderValue !== null ? formatCurrency(data.finance.avgOrderValue) : null}
                    unavailableReason="Aucune commande"
                    icon={ShoppingBag}
                    tone="info"
                    explain={<DashboardMetricInfo metric="averageBasket" className="-ml-1" />}
                  />
                )}
                {canViewCustomers && (
                  <KpiCard size="lg" label={`Nouveaux clients (${suffix})`} value={String(data.newCustomersThisPeriod)} icon={Users} tone="info" explain={<DashboardMetricInfo metric="newCustomers" className="-ml-1" />} />
                )}
              </FadeIn>
            )}
            {/* The revenue breakdown that ISN'T already the headline — still
                worth showing (e.g. the total is the hero, but the online/store
                split behind it is real information), just no longer competing
                with it for attention. */}
            {((!showOnlineHeadline && canViewFinance && showOnline) || (!showOfflineHeadline && offlineSummary && showOffline)) && (
              <FadeIn className="grid gap-5 sm:grid-cols-2">
                {!showOnlineHeadline && canViewFinance && showOnline && (
                  <KpiCard
                    size="lg"
                    label={`Chiffre d'affaires${canFilterChannel ? " en ligne" : ""} (${suffix})`}
                    value={formatCurrency(data.finance.revenue)}
                    trend={trend(data.finance.revenue, data.previousFinance.revenue)}
                    icon={Wallet}
                    tone="primary"
                    explain={<DashboardMetricInfo metric="revenue" className="-ml-1" />}
                  />
                )}
                {!showOfflineHeadline && offlineSummary && showOffline && (
                  <KpiCard
                    size="lg"
                    label={`Ventes magasin nettes (${suffix})`}
                    value={formatCurrency(offlineSummary.netSales)}
                    hint={`${offlineSummary.salesCount} vente(s) · ${offlineSummary.unitsSold} article(s)`}
                    icon={Store}
                    tone="primary"
                    explain={<DashboardMetricInfo metric="storeNetSales" className="-ml-1" />}
                  />
                )}
              </FadeIn>
            )}
          </div>

          {/* Side card with lists — « Meilleures ventes » (orders.view, online scope). */}
          {showTopSellers && (
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle accent="yellow">
                  <span className="flex items-center gap-1">
                    Meilleures ventes
                    <DashboardMetricInfo metric="topSelling" />
                  </span>
                </CardTitle>
                <CardAction>
                  <Button variant="ghost" size="sm" render={<Link href="/analyses" />}>
                    Voir tout <ArrowRight className="size-4" />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {topSellingUnits.length === 0 ? (
                  <EmptyState icon={Trophy} title="Aucune vente enregistrée sur la période." />
                ) : (
                  <TopSellingProducts units={topSellingUnits} />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </SummarySection>

      {canViewFinance && showOnline && (
        <SummarySection title={offlineSummary !== null ? "Rentabilité — commandes en ligne" : "Rentabilité"} icon={TrendingUp} className="mb-8">
          <FadeIn className="grid gap-5 sm:grid-cols-2">
            <KpiCard
              size="lg"
              label={`Charges (${suffix})`}
              value={formatCurrency(data.finance.chargesTotal)}
              hint="Dépenses enregistrées + coût de livraison"
              trend={trend(data.finance.chargesTotal, data.previousFinance.chargesTotal)}
              icon={Receipt}
              tone="warning"
              explain={<DashboardMetricInfo metric="charges" className="-ml-1" />}
            />
            <KpiCard
              size="lg"
              label={`Bénéfice net (${suffix})`}
              value={data.finance.netProfit !== null ? formatCurrency(data.finance.netProfit) : null}
              unavailableReason="Non calculable"
              hint={!data.finance.cogsComplete ? "Coût d'achat manquant sur certains produits" : undefined}
              icon={TrendingUp}
              tone="success"
              explain={<DashboardMetricInfo metric="netProfit" className="-ml-1" />}
            />
          </FadeIn>
        </SummarySection>
      )}

      {/* Wide chart card. */}
      {canViewFinance && showOnline && (
        <SummarySection title="Ventes" icon={LineChart} className="mb-8">
          <Card>
            <CardHeader>
              <CardTitle accent="blue">
                <span className="flex items-center gap-1">
                  Chiffre d&apos;affaires{canFilterChannel ? " en ligne" : ""} — {REVENUE_TREND_LABELS[chartRange].toLowerCase()}
                  <DashboardMetricInfo metric="revenueTrend" />
                </span>
              </CardTitle>
              <CardAction>
                <FilterDropdownPill
                  ariaLabel="Graphique"
                  items={(Object.keys(REVENUE_TREND_LABELS) as RevenueTrendRange[]).map((key) => ({
                    key,
                    label: REVENUE_TREND_LABELS[key],
                    href: withParam(params, "graphique", key === "annee" ? undefined : key),
                    active: key === chartRange,
                  }))}
                />
              </CardAction>
            </CardHeader>
            <CardContent>
              <RevenueTrendChart data={revenueTrend} />
            </CardContent>
          </Card>
        </SummarySection>
      )}

      {(canViewInventory || stockOverview) && (
        <SummarySection title="Stock" icon={Package2} className="mb-8">
          <FadeIn className="grid gap-5 sm:grid-cols-2">
            {stockOverview && (
              <Card>
                <CardHeader>
                  <CardTitle accent="green">
                    <span className="flex items-center gap-1">
                      Stock physique
                      <DashboardMetricInfo metric="stockOnHand" />
                    </span>
                  </CardTitle>
                  <CardDescription>Réparti entre réservé et disponible</CardDescription>
                </CardHeader>
                <CardContent>
                  <StockDonut
                    total={String(stockOverview.onHand)}
                    segments={[
                      { label: "Disponible", value: stockOverview.available, color: CHART_COLORS.series[2] },
                      { label: "Réservé", value: stockOverview.reserved, color: CHART_COLORS.series[4] },
                    ]}
                  />
                </CardContent>
              </Card>
            )}
            {canViewInventory && (
              <KpiCard
                size="lg"
                label="Produits en stock faible"
                value={String(data.lowStockCount)}
                hint={data.lowStockCount > 0 ? "Nécessite votre attention" : undefined}
                icon={AlertCircle}
                tone={data.lowStockCount > 0 ? "warning" : "success"}
                explain={<DashboardMetricInfo metric="lowStock" className="-ml-1" />}
              />
            )}
          </FadeIn>
        </SummarySection>
      )}

      {showOnlineOps && (confirmationSummary || commissionSummary || canViewDelivery) && (
        <SummarySection
          title="Opérations"
          icon={Activity}
          className="mb-8"
          action={
            canViewCommissions &&
            (confirmationSummary || commissionSummary) && (
              <Link href="/confirmation/performance" className="text-sm font-medium text-ink-secondary underline-offset-4 hover:text-ink hover:underline">
                Performance confirmation →
              </Link>
            )
          }
        >
          {(confirmationSummary || commissionSummary) && (
            <p className="-mt-1 text-xs text-ink-muted">
              Confirmation et commissions : file en cours et mois en cours, indépendamment de la période choisie. Taux de livraison : période choisie.
            </p>
          )}
          <FadeIn className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {/* "Breakdown KPI": three related confirmation counts read as ONE
                pipeline, not three unrelated tiles. */}
            {confirmationSummary && (
              <Card>
                <CardContent>
                  <MetricBreakdown
                    rows={[
                      { key: "toConfirm", label: "À confirmer", value: String(confirmationSummary.toConfirm), icon: PhoneCall, tone: "default", explain: <DashboardMetricInfo metric="toConfirm" /> },
                      {
                        key: "confirmedThisMonth",
                        label: "Confirmées ce mois",
                        value: String(confirmationSummary.confirmedThisMonth),
                        icon: CheckCircle2,
                        tone: "success",
                        explain: <DashboardMetricInfo metric="confirmedThisMonth" />,
                      },
                      { key: "toRecall", label: "À rappeler", value: String(confirmationSummary.toRecall), icon: RotateCcw, tone: "warning", explain: <DashboardMetricInfo metric="toRecall" /> },
                    ]}
                  />
                </CardContent>
              </Card>
            )}
            {/* Commission earned + still owed are two sides of ONE ledger. */}
            {commissionSummary && (
              <Card>
                <CardHeader>
                  <CardTitle accent="purple">Commissions</CardTitle>
                </CardHeader>
                <CardContent>
                  <MetricBreakdown
                    rows={[
                      {
                        key: "earned",
                        label: "Gagnée ce mois",
                        value: formatCurrency(commissionSummary.earnedThisMonth, commissionSummary.currency),
                        explain: <DashboardMetricInfo metric="commissionEarned" />,
                      },
                      {
                        key: "remaining",
                        label: "Reste à payer",
                        value: formatCurrency(commissionSummary.remainingTotal, commissionSummary.currency),
                        tone: commissionSummary.remainingTotal > 0 ? "warning" : "default",
                        explain: <DashboardMetricInfo metric="commissionRemaining" />,
                      },
                    ]}
                  />
                </CardContent>
              </Card>
            )}
            {canViewDelivery && (
              <KpiCard
                size="lg"
                label="Taux de livraison réussie"
                value={data.deliveryStats.successRate !== null ? `${(data.deliveryStats.successRate * 100).toFixed(1)}%` : null}
                hint={`${data.deliveryStats.delivered} livrée(s) sur ${data.deliveryStats.delivered + data.deliveryStats.failed + data.deliveryStats.returned} terminée(s) sur la période`}
                explain={<DashboardMetricInfo metric="deliveryRate" className="-ml-1" />}
                unavailableReason="Aucune livraison terminée sur la période"
                icon={Truck}
                tone="info"
              />
            )}
          </FadeIn>
        </SummarySection>
      )}

      {/* Every card below needs orders.view or audit.view — without either
          (e.g. STORE_SELLER) the section would be a bare heading (Phase 4B). */}
      {((canViewOrders && showOnlineOps) || canViewAudit) && (
        <SummarySection title="Activité" icon={ShoppingCart}>
          <div className={canViewOrders && showOnlineOps && canViewAudit ? "grid gap-5 lg:grid-cols-3" : "grid gap-5 lg:grid-cols-2"}>
            {canViewOrders && showOnlineOps && (
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle accent="peach">
                    <span className="flex items-center gap-1">
                      Commandes nécessitant une action
                      <DashboardMetricInfo metric="ordersRequiringAction" />
                    </span>
                  </CardTitle>
                  <CardAction>
                    <Button variant="ghost" size="sm" render={<Link href="/commandes" />}>
                      Voir tout <ArrowRight className="size-4" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {data.ordersRequiringAction.length === 0 ? (
                    <EmptyState icon={ShoppingCart} title="Aucune commande en attente d'action." />
                  ) : (
                    <ul className="divide-y divide-hairline">
                      {data.ordersRequiringAction.map((o) => (
                        <OrderRow
                          key={o.id}
                          order={o}
                          orderNumberPrefix={business.orderNumberPrefix}
                          action={
                            <Button size="icon-sm" variant="outline" aria-label={`Ouvrir ${displayOrderNumber(o, business.orderNumberPrefix)}`} render={<Link href={`/commandes/${o.id}`} />}>
                              <ArrowRight className="size-4" />
                            </Button>
                          }
                        />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {canViewOrders && showOnlineOps && (
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle accent="blue">
                    <span className="flex items-center gap-1">
                      Commandes récentes
                      <DashboardMetricInfo metric="recentOrders" />
                    </span>
                  </CardTitle>
                  <CardAction>
                    <Button variant="ghost" size="sm" render={<Link href="/commandes" />}>
                      Voir tout <ArrowRight className="size-4" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {data.recentOrders.length === 0 ? (
                    <EmptyState icon={ShoppingCart} title="Aucune commande pour le moment." />
                  ) : (
                    <ul className="divide-y divide-hairline">
                      {data.recentOrders.map((o) => (
                        <OrderRow key={o.id} order={o} orderNumberPrefix={business.orderNumberPrefix} />
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {canViewAudit && (
              <Card className="min-w-0">
                <CardHeader>
                  <CardTitle accent="green">
                    <span className="flex items-center gap-1">
                      Activité récente
                      <DashboardMetricInfo metric="recentActivity" />
                    </span>
                  </CardTitle>
                  <CardAction>
                    <Button variant="ghost" size="sm" render={<Link href="/journal-audit" />}>
                      Voir tout <ArrowRight className="size-4" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {data.recentAuditEvents.length === 0 ? (
                    <EmptyState icon={Boxes} title="Aucune activité enregistrée." />
                  ) : (
                    <ul className="divide-y divide-hairline">
                      {data.recentAuditEvents.map((e) => (
                        <li key={e.id} className="py-3 text-sm">
                          <p>
                            <span className="font-medium text-ink">{e.actorUser?.name ?? "Système"}</span>{" "}
                            <span className="text-ink-secondary">— {humanizeAuditAction(e.action)}</span>
                          </p>
                          <p className="mt-0.5 text-xs text-ink-muted">{formatDateTime(e.createdAt)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </SummarySection>
      )}

      <DashboardDefinitions />
    </div>
  );
}
