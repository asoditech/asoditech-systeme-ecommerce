import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AnalyticsNav } from "@/components/analytics/analytics-nav";
import { AnalyticsFilterBar, type AnalyticsFilterControl } from "@/components/analytics/analytics-filter-bar";
import { BreakdownBarList } from "@/components/analytics/breakdown-bar-list";
import { MetricDefinitions } from "@/components/analytics/metric-definitions";
import { analyticsContext } from "@/lib/analytics/context";
import { analyticsQuery, SOURCE_KEYS, sourceLabel } from "@/lib/analytics/filters";
import { formatPct } from "@/lib/analytics/format";
import { getOnlineSourceFunnel, getOnlineFilterOptions } from "@/lib/analytics/queries/online";
import { getStoreOverview, getStoreFilterOptions } from "@/lib/analytics/queries/store";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Analyses — Origines & magasins — ASODITECH Gestion E-commerce" };

const COLORS = ["bg-primary", "bg-violet-500", "bg-cyan-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-slate-400", "bg-fuchsia-500"];

/**
 * Sources and channels (docs/adr/0051). The Online part is a lifecycle
 * funnel per order origin; the store part is POS sales per store and per
 * location — no funnel, because an in-store sale has no confirmation or
 * delivery. The two are never summed into a shared lifecycle metric.
 */
export default async function SourcesAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await analyticsContext(await searchParams, "sources");
  const { access, period, filters, user } = ctx;
  const [funnel, store, onlineOptions, storeOptions] = await Promise.all([
    access.online ? getOnlineSourceFunnel(period.range, filters) : null,
    access.store ? getStoreOverview(user, period, filters) : null,
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

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses — Origines & magasins" description={`Commandes en ligne par origine, ventes en magasin par magasin et emplacement — ${period.label}.`} />
      <AnalyticsNav access={access} active="sources" query={ctx.periodQuery} />
      <AnalyticsFilterBar basePath="/analyses/canaux" period={period} filterParams={ctx.filterParams} controls={controls} exportHref={`/analyses/export/canaux?${analyticsQuery(period, filters)}`} />

      {funnel && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Commandes en ligne par origine</CardTitle>
            </CardHeader>
            <CardContent>
              {funnel.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune commande sur la période.</p>
              ) : (
                <BreakdownBarList
                  items={funnel.map((r, i) => ({ key: r.key, count: r.orders, label: <span className="text-sm font-medium">{r.label}</span>, barColor: COLORS[i % COLORS.length] }))}
                />
              )}
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Entonnoir par origine (commandes passées sur la période)</CardTitle>
            </CardHeader>
            <CardContent>
              {funnel.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune commande sur la période.</p>
              ) : (
                <Table className="text-[13px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Origine</TableHead>
                      <TableHead className="text-right">Commandes</TableHead>
                      <TableHead className="text-right">Confirmées</TableHead>
                      <TableHead className="text-right">Expédiées</TableHead>
                      <TableHead className="text-right">Livrées</TableHead>
                      <TableHead className="text-right">Retournées</TableHead>
                      <TableHead className="text-right">Annulées</TableHead>
                      <TableHead className="text-right">Taux conf.</TableHead>
                      <TableHead className="text-right">Taux livr.</TableHead>
                      <TableHead className="text-right">CA commandé</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {funnel.map((r) => (
                      <TableRow key={r.key}>
                        <TableCell className="font-medium">{r.label}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.confirmed}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.shipped}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.returned}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.cancelled}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatPct(r.confirmationRate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatPct(r.deliveryRate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {store && (
        <div className="grid gap-6 lg:grid-cols-2">
          {[
            { title: "Ventes en magasin par magasin", rows: store.report.byChannel.map((c) => ({ key: c.channelId, name: c.name, gross: c.gross, count: c.count })) },
            { title: "Ventes en magasin par emplacement", rows: store.report.byLocation.map((w) => ({ key: w.warehouseId, name: w.name, gross: w.gross, count: w.count })) },
          ].map((block) => (
            <Card key={block.title}>
              <CardHeader>
                <CardTitle>{block.title}</CardTitle>
              </CardHeader>
              <CardContent>
                {block.rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune vente en magasin sur la période.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nom</TableHead>
                        <TableHead className="text-right">Ventes</TableHead>
                        <TableHead className="text-right">CA brut</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {block.rows.map((r) => (
                        <TableRow key={r.key}>
                          <TableCell className="font-medium">{r.name}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(r.gross)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <MetricDefinitions section="sources" />
    </div>
  );
}
