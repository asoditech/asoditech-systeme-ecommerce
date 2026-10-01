import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AnalyticsNav } from "@/components/analytics/analytics-nav";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { BreakdownBarList } from "@/components/analytics/breakdown-bar-list";
import { SeriesChart } from "@/components/analytics/series-chart";
import { SortHeader } from "@/components/analytics/sort-header";
import { MetricDefinitions } from "@/components/analytics/metric-definitions";
import { Truck, PackageCheck, TriangleAlert, Undo2, Timer, Clock, Hourglass, Percent } from "lucide-react";
import { analyticsContext } from "@/lib/analytics/context";
import { analyticsQuery, SOURCE_KEYS, sortRows, sourceLabel } from "@/lib/analytics/filters";
import { formatHours, formatPct } from "@/lib/analytics/format";
import { getDeliveryAnalytics, getOnlineFilterOptions, type DeliveryRow } from "@/lib/analytics/queries/online";

export const metadata = { title: "Analyses — Livraison — ASODITECH Gestion E-commerce" };

/**
 * Delivery analytics (docs/adr/0051): Online orders SHIPPED in the period,
 * outcome by current status, durations only from real timestamps. Carrier
 * costs are finance data and are not part of this page (see the delivery
 * report with `finance.view`).
 */
export default async function DeliveryAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await analyticsContext(await searchParams, "delivery");
  const { period, filters } = ctx;
  const [d, options] = await Promise.all([getDeliveryAnalytics(period, filters), getOnlineFilterOptions()]);
  const o = d.overall;

  const cols = {
    label: (r: DeliveryRow) => r.label.toLowerCase(),
    shipped: (r: DeliveryRow) => r.shipped,
    delivered: (r: DeliveryRow) => r.delivered,
    failed: (r: DeliveryRow) => r.failed,
    returned: (r: DeliveryRow) => r.returned,
    rate: (r: DeliveryRow) => r.deliveryRate,
  };
  const providers = sortRows(d.byProvider, filters, cols, "shipped");
  const sortKey = filters.sort && filters.sort in cols ? filters.sort : "shipped";
  const dir = filters.dir ?? "desc";
  const head = (column: string, label: string, className?: string) => (
    <SortHeader column={column} label={label} basePath="/analyses/livraison" params={ctx.params} active={sortKey === column} dir={dir} className={className} />
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses — Livraison" description={`Commandes en ligne expédiées — ${period.label}.`} />
      <AnalyticsNav access={ctx.access} active="delivery" query={ctx.periodQuery} />
      <AnalyticsFilterBar
        basePath="/analyses/livraison"
        period={period}
        filterParams={ctx.filterParams}
        exportHref={`/analyses/export/livraison?${analyticsQuery(period, filters)}`}
        controls={[
          { paramKey: "source", value: filters.source, allLabel: "Toutes les origines", options: SOURCE_KEYS.map((k) => ({ value: k, label: sourceLabel(k) })) },
          { paramKey: "transporteur", value: filters.providerId, allLabel: "Tous les transporteurs", options: options.providers.map((p) => ({ value: p.id, label: p.name })) },
        ]}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Expédiées" value={String(o.shipped)} icon={Truck} hint={`${o.inProgress} encore en cours`} />
        <KpiCard label="Livrées" value={String(o.delivered)} icon={PackageCheck} tone="success" />
        <KpiCard label="Échecs" value={String(o.failed)} icon={TriangleAlert} tone="danger" />
        <KpiCard label="Retournées" value={String(o.returned)} icon={Undo2} tone="danger" />
        <KpiCard label="Taux de livraison" value={o.deliveryRate === null ? null : formatPct(o.deliveryRate)} unavailableReason="Aucune expédition" icon={Percent} tone="success" />
        <KpiCard label="Taux d'échec" value={o.failureRate === null ? null : formatPct(o.failureRate)} unavailableReason="Aucune expédition" icon={Percent} tone="danger" />
        <KpiCard label="Taux de retour" value={o.returnRate === null ? null : formatPct(o.returnRate)} unavailableReason="Aucune expédition" icon={Percent} tone="warning" />
        <KpiCard label="Confirmée → expédiée" value={d.confirmedToShipped.sample ? formatHours(d.confirmedToShipped.avgHours) : null} unavailableReason="Aucune donnée" icon={Timer} hint={d.confirmedToShipped.sample ? `moyenne sur ${d.confirmedToShipped.sample}` : undefined} />
        <KpiCard label="Expédiée → livrée" value={d.shippedToDelivered.sample ? formatHours(d.shippedToDelivered.avgHours) : null} unavailableReason="Aucune livraison datée" icon={Clock} hint={d.shippedToDelivered.sample ? `moyenne sur ${d.shippedToDelivered.sample}` : undefined} />
        <KpiCard label="Confirmée → livrée" value={d.confirmedToDelivered.sample ? formatHours(d.confirmedToDelivered.avgHours) : null} unavailableReason="Aucune livraison datée" icon={Hourglass} hint={d.confirmedToDelivered.sample ? `moyenne sur ${d.confirmedToDelivered.sample}` : undefined} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Expéditions et issues — par date d&apos;expédition</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={d.series}
              series={[
                { key: "shipped", label: "Expédiées", color: "var(--color-muted-foreground)" },
                { key: "delivered", label: "Livrées", color: "#10b981" },
                { key: "failed", label: "Échecs", color: "#f43f5e" },
                { key: "returned", label: "Retournées", color: "#f59e0b" },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Issue des expéditions</CardTitle>
          </CardHeader>
          <CardContent>
            {o.shipped === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune expédition sur la période.</p>
            ) : (
              <BreakdownBarList
                items={[
                  { key: "delivered", count: o.delivered, label: <span className="text-sm font-medium">Livrées</span>, barColor: "bg-emerald-500" },
                  { key: "failed", count: o.failed, label: <span className="text-sm font-medium">Échecs</span>, barColor: "bg-rose-500" },
                  { key: "returned", count: o.returned, label: <span className="text-sm font-medium">Retournées</span>, barColor: "bg-amber-500" },
                  { key: "inProgress", count: o.inProgress, label: <span className="text-sm font-medium">En cours</span>, barColor: "bg-slate-400" },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Par transporteur</CardTitle>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune expédition sur la période.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {head("label", "Transporteur")}
                  {head("shipped", "Expédiées", "text-right")}
                  {head("delivered", "Livrées", "text-right")}
                  {head("failed", "Échecs", "text-right")}
                  {head("returned", "Retournées", "text-right")}
                  {head("rate", "Taux de livraison", "text-right")}
                  <TableHead className="text-right">Expédiée → livrée</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.shipped}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.failed}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.returned}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPct(r.deliveryRate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatHours(r.shippedToDelivered.avgHours)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Par origine</CardTitle>
        </CardHeader>
        <CardContent>
          {d.bySource.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune expédition sur la période.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Origine</TableHead>
                  <TableHead className="text-right">Expédiées</TableHead>
                  <TableHead className="text-right">Livrées</TableHead>
                  <TableHead className="text-right">Échecs</TableHead>
                  <TableHead className="text-right">Retournées</TableHead>
                  <TableHead className="text-right">Taux de livraison</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.bySource.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.shipped}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.failed}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.returned}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPct(r.deliveryRate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <MetricDefinitions section="delivery" />
    </div>
  );
}
