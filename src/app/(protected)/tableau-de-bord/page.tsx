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
  HandCoins,
  Store,
  LayoutGrid,
  LineChart,
  Package2,
  Activity,
  AlertCircle,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { SummarySection } from "@/components/summary-section";
import { MetricWithProgress } from "@/components/metric-with-progress";
import { FadeIn } from "@/components/motion/stagger-list";
import { RevenueTrendChart } from "@/components/dashboard/revenue-trend-chart";
import { TopSellingProducts } from "@/components/dashboard/top-selling-products";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
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
    <li className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <Link href={`/commandes/${order.id}`} className="min-w-0 flex-1 hover:underline">
        <p className="truncate font-medium">{displayOrderNumber(order, orderNumberPrefix)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {displayOrderRecipient(order)} · {displayOrderChannel(order)} · {formatDate(order.placedAt)}
        </p>
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-medium tabular-nums">{formatCurrency(order.total.toString(), order.currency)}</span>
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
  const params = await searchParams;
  const periodKey: DashboardPeriod = isDashboardPeriod(params.periode) ? params.periode : "mois";
  const chartRange: RevenueTrendRange =
    params.graphique && REVENUE_TREND_LABELS[params.graphique as RevenueTrendRange]
      ? (params.graphique as RevenueTrendRange)
      : "annee";

  const [data, revenueTrend, business] = await Promise.all([
    getDashboardData(periodKey, undefined, { auditScope: auditScopeWhere(user.channels) }),
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
  // Same formula getChannelReport's own `total` uses (combinedChannelRevenue,
  // src/lib/queries/reports/channels.ts) — reusing the two figures already
  // computed on this same page rather than a second call to that report.
  const totalRevenue =
    canFilterChannel && canalKey === "total" && offlineSummary
      ? combinedChannelRevenue(data.finance.revenue, offlineSummary.netSales)
      : null;

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={`Bonjour ${user.name.split(" ")[0]}, voici l'état de votre activité.`}
        actions={
          <div className="flex flex-wrap items-center gap-1">
            {(Object.keys(DASHBOARD_PERIOD_LABELS) as DashboardPeriod[]).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={key === periodKey ? "default" : "outline"}
                render={<Link href={withParam(params, "periode", key === "mois" ? undefined : key)} />}
              >
                {DASHBOARD_PERIOD_LABELS[key]}
              </Button>
            ))}
          </div>
        }
      />

      {canFilterChannel && (
        <div className="mb-4 flex flex-wrap items-center gap-1">
          {(Object.keys(CHANNEL_FILTER_LABELS) as DashboardChannelFilter[]).map((key) => (
            <Button
              key={key}
              size="sm"
              variant={key === canalKey ? "default" : "outline"}
              render={<Link href={withParam(params, "canal", key === "total" ? undefined : key)} />}
            >
              {CHANNEL_FILTER_LABELS[key]}
            </Button>
          ))}
        </div>
      )}

      <SummarySection title="Aperçu" icon={LayoutGrid} className="mb-6">
        <FadeIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {totalRevenue !== null && (
            <KpiCard
              label={`Chiffre d'affaires total (${suffix})`}
              value={formatCurrency(totalRevenue)}
              hint="En ligne + Magasin net"
              icon={Wallet}
              tone="primary"
            />
          )}
          {canViewFinance && showOnline && (
            <KpiCard
              label={`Chiffre d'affaires${canFilterChannel ? " en ligne" : ""} (${suffix})`}
              value={formatCurrency(data.finance.revenue)}
              trend={trend(data.finance.revenue, data.previousFinance.revenue)}
              icon={Wallet}
              tone="primary"
            />
          )}
          {canViewOrders && showOnline && (
            <KpiCard label={`Commandes (${suffix})`} value={String(data.finance.ordersCount)} icon={ShoppingCart} tone="violet" />
          )}
          {canViewFinance && showOnline && (
            <KpiCard
              label={`Panier moyen (${suffix})`}
              value={data.finance.avgOrderValue !== null ? formatCurrency(data.finance.avgOrderValue) : null}
              unavailableReason="Aucune commande"
              icon={ShoppingBag}
              tone="info"
            />
          )}
          {offlineSummary && showOffline && (
            <KpiCard
              label={`Ventes magasin nettes (${suffix})`}
              value={formatCurrency(offlineSummary.netSales)}
              hint={`${offlineSummary.salesCount} vente(s) · ${offlineSummary.unitsSold} article(s)`}
              icon={Store}
              tone="primary"
            />
          )}
          {canViewCustomers && (
            <KpiCard label={`Nouveaux clients (${suffix})`} value={String(data.newCustomersThisPeriod)} icon={Users} tone="info" />
          )}
        </FadeIn>
      </SummarySection>

      {canViewFinance && showOnline && (
        <SummarySection title="Rentabilité" icon={TrendingUp} className="mb-6">
          <FadeIn className="grid gap-4 sm:grid-cols-2">
            <KpiCard
              label={`Charges (${suffix})`}
              value={formatCurrency(data.finance.chargesTotal)}
              hint="Dépenses enregistrées + coût de livraison"
              trend={trend(data.finance.chargesTotal, data.previousFinance.chargesTotal)}
              icon={Receipt}
              tone="warning"
            />
            <KpiCard
              label={`Bénéfice net (${suffix})`}
              value={data.finance.netProfit !== null ? formatCurrency(data.finance.netProfit) : null}
              unavailableReason="Non calculable"
              hint={!data.finance.cogsComplete ? "Coût d'achat manquant sur certains produits" : undefined}
              icon={TrendingUp}
              tone="success"
            />
          </FadeIn>
        </SummarySection>
      )}

      {(canViewInventory || stockOverview) && (
        <SummarySection title="Stock" icon={Package2} className="mb-6">
          <FadeIn className="grid gap-4 sm:grid-cols-2">
            {stockOverview && (
              <MetricWithProgress
                label="Stock physique"
                value={String(stockOverview.onHand)}
                hint="Réparti entre réservé et disponible"
                icon={Boxes}
                segments={[
                  { label: "Disponible", value: stockOverview.available, className: "bg-emerald-500" },
                  { label: "Réservé", value: stockOverview.reserved, className: "bg-amber-500" },
                ]}
              />
            )}
            {canViewInventory && (
              <KpiCard
                label="Produits en stock faible"
                value={String(data.lowStockCount)}
                hint={data.lowStockCount > 0 ? "Nécessite votre attention" : undefined}
                icon={AlertCircle}
                tone={data.lowStockCount > 0 ? "danger" : "primary"}
              />
            )}
          </FadeIn>
        </SummarySection>
      )}

      {(confirmationSummary || commissionSummary || canViewDelivery) && (
        <SummarySection
          title="Opérations"
          icon={Activity}
          className="mb-6"
          action={
            canViewCommissions &&
            (confirmationSummary || commissionSummary) && (
              <Link href="/confirmation/performance" className="text-xs text-primary hover:underline">
                Performance confirmation →
              </Link>
            )
          }
        >
          <FadeIn className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {confirmationSummary && (
              <>
                <KpiCard label="À confirmer" value={String(confirmationSummary.toConfirm)} icon={PhoneCall} tone="primary" />
                <KpiCard label="Confirmées ce mois" value={String(confirmationSummary.confirmedThisMonth)} icon={CheckCircle2} tone="success" />
                <KpiCard label="À rappeler" value={String(confirmationSummary.toRecall)} icon={RotateCcw} tone="warning" />
              </>
            )}
            {commissionSummary && (
              <>
                <KpiCard
                  label="Commission du mois"
                  value={formatCurrency(commissionSummary.earnedThisMonth, commissionSummary.currency)}
                  icon={HandCoins}
                  tone="info"
                />
                <KpiCard
                  label="À payer"
                  value={formatCurrency(commissionSummary.remainingTotal, commissionSummary.currency)}
                  icon={Wallet}
                  tone="violet"
                />
              </>
            )}
            {canViewDelivery && (
              <KpiCard
                label="Taux de livraison réussie"
                value={data.deliveryStats.successRate !== null ? `${(data.deliveryStats.successRate * 100).toFixed(1)}%` : null}
                unavailableReason="Aucune expédition"
                icon={Truck}
                tone="warning"
              />
            )}
          </FadeIn>
        </SummarySection>
      )}

      {((canViewFinance && showOnline) || canViewOrders) && (
        <SummarySection title="Ventes" icon={LineChart} className="mb-6">
          <div className="grid gap-6 lg:grid-cols-3">
            {canViewFinance && showOnline && (
              <Card className={canViewOrders ? "lg:col-span-2" : "lg:col-span-3"}>
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle>
                    Chiffre d&apos;affaires{canFilterChannel ? " en ligne" : ""} — {REVENUE_TREND_LABELS[chartRange].toLowerCase()}
                  </CardTitle>
                  <div className="flex flex-wrap gap-1">
                    {(Object.keys(REVENUE_TREND_LABELS) as RevenueTrendRange[]).map((key) => (
                      <Button
                        key={key}
                        size="sm"
                        variant={key === chartRange ? "default" : "ghost"}
                        render={<Link href={withParam(params, "graphique", key === "annee" ? undefined : key)} />}
                      >
                        {REVENUE_TREND_LABELS[key]}
                      </Button>
                    ))}
                  </div>
                </CardHeader>
                <CardContent>
                  <RevenueTrendChart data={revenueTrend} />
                </CardContent>
              </Card>
            )}

            {canViewOrders && (
              <Card className={canViewFinance && showOnline ? "" : "lg:col-span-3"}>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-1.5">
                    <Trophy className="size-4 text-primary" />
                    Meilleures ventes
                  </CardTitle>
                  <Button variant="ghost" size="sm" render={<Link href="/analyses" />}>
                    Voir tout <ArrowRight className="size-4" />
                  </Button>
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
      )}

      <SummarySection title="Activité" icon={ShoppingCart}>
        <div className="grid gap-6 lg:grid-cols-2">
          {canViewOrders && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Commandes nécessitant une action</CardTitle>
                <Button variant="ghost" size="sm" render={<Link href="/commandes" />}>
                  Voir tout <ArrowRight className="size-4" />
                </Button>
              </CardHeader>
              <CardContent>
                {data.ordersRequiringAction.length === 0 ? (
                  <EmptyState icon={ShoppingCart} title="Aucune commande en attente d'action." />
                ) : (
                  <ul className="divide-y">
                    {data.ordersRequiringAction.map((o) => (
                      <OrderRow
                        key={o.id}
                        order={o}
                        orderNumberPrefix={business.orderNumberPrefix}
                        action={
                          <Button size="icon-xs" variant="outline" render={<Link href={`/commandes/${o.id}`} />}>
                            <ArrowRight className="size-3.5" />
                          </Button>
                        }
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {canViewOrders && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Commandes récentes</CardTitle>
                <Button variant="ghost" size="sm" render={<Link href="/commandes" />}>
                  Voir tout <ArrowRight className="size-4" />
                </Button>
              </CardHeader>
              <CardContent>
                {data.recentOrders.length === 0 ? (
                  <EmptyState icon={ShoppingCart} title="Aucune commande pour le moment." />
                ) : (
                  <ul className="divide-y">
                    {data.recentOrders.map((o) => (
                      <OrderRow key={o.id} order={o} orderNumberPrefix={business.orderNumberPrefix} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {canViewAudit && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Activité récente</CardTitle>
                <Button variant="ghost" size="sm" render={<Link href="/journal-audit" />}>
                  Voir tout <ArrowRight className="size-4" />
                </Button>
              </CardHeader>
              <CardContent>
                {data.recentAuditEvents.length === 0 ? (
                  <EmptyState icon={Boxes} title="Aucune activité enregistrée." />
                ) : (
                  <ul className="divide-y">
                    {data.recentAuditEvents.map((e) => (
                      <li key={e.id} className="py-2.5 text-sm">
                        <p>
                          <span className="font-medium">{e.actorUser?.name ?? "Système"}</span>{" "}
                          <span className="text-muted-foreground">— {e.action}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </SummarySection>
    </div>
  );
}
