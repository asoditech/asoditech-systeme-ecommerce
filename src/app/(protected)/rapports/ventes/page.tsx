import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { trendFromDelta } from "@/lib/reports/trend";
import { getSalesReport } from "@/lib/queries/reports/sales";
import { formatCurrency, formatDate } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Rapport de ventes — ASODITECH Gestion E-commerce" };

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);

export default async function RapportVentesPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePermission("analytics.view");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const report = await getSalesReport(resolved.range, resolved.previous);
  const { current, previous, deltas } = report;

  const exportHref = `/rapports/export/ventes?${rangeQuery(resolved)}`;

  return (
    <div>
      <PageHeader title="Rapport de ventes" description={`Période : ${resolved.label} — comparé à la période précédente de même durée.`} />
      <ReportFilterBar basePath="/rapports/ventes" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Chiffre d'affaires" value={formatCurrency(current.revenue)} tone="primary"
          trend={trendFromDelta(deltas.revenue)} hint={`${previous.revenue.toLocaleString("fr")} période préc.`} />
        <KpiCard label="Commandes" value={String(current.ordersCount)} tone="info"
          trend={trendFromDelta(deltas.ordersCount)} hint={`${previous.ordersCount} période préc.`} />
        <KpiCard label="Panier moyen" value={current.avgOrderValue !== null ? formatCurrency(current.avgOrderValue) : null}
          tone="violet" trend={trendFromDelta(deltas.avgOrderValue)} />
        <KpiCard label="Articles vendus" value={String(current.unitsSold)} tone="primary"
          trend={trendFromDelta(deltas.unitsSold)} />
        <KpiCard label="Taux de confirmation" value={pct(current.confirmationRate)} tone="success"
          trend={trendFromDelta(deltas.confirmationRate)} />
        <KpiCard label="Taux de livraison" value={pct(current.deliveryRate)} tone="success"
          trend={trendFromDelta(deltas.deliveryRate)} />
        <KpiCard label="Taux de retour" value={pct(current.returnRate)} tone="warning"
          trend={trendFromDelta(deltas.returnRate, { invert: true })} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Par statut de commande</CardTitle></CardHeader>
          <CardContent>
            <Table className="text-[13px]">
              <TableHeader><TableRow><TableHead>Statut</TableHead><TableHead className="text-right">Commandes</TableHead><TableHead className="text-right">Montant</TableHead></TableRow></TableHeader>
              <TableBody>
                {report.byStatus.map((r) => (
                  <TableRow key={r.status}>
                    <TableCell><StatusBadge status={r.status} labels={ORDER_STATUS_LABELS} /></TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Par canal</CardTitle></CardHeader>
          <CardContent>
            <Table className="text-[13px]">
              <TableHeader><TableRow><TableHead>Canal</TableHead><TableHead className="text-right">Commandes</TableHead><TableHead className="text-right">CA</TableHead></TableRow></TableHeader>
              <TableBody>
                {report.byChannel.map((r) => (
                  <TableRow key={r.channel}>
                    <TableCell>{r.channel}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle>Détail par jour</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="text-[13px]">
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Commandes</TableHead><TableHead className="text-right">CA</TableHead></TableRow></TableHeader>
            <TableBody>
              {report.daily.map((d) => (
                <TableRow key={d.date}>
                  <TableCell>{formatDate(new Date(d.date))}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.orders}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(d.revenue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
