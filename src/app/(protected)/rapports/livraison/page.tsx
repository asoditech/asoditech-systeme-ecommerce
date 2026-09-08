import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getDeliveryPerformanceReport, type DeliveryPerfRow } from "@/lib/queries/reports/delivery";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Performance livraison — ASODITECH Gestion E-commerce" };

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const days = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} j`);

function PerfTable({ rows, label }: { rows: DeliveryPerfRow[]; label: string }) {
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Exp.</TableHead>
          <TableHead className="text-right">Livrées</TableHead>
          <TableHead className="text-right">Échecs</TableHead>
          <TableHead className="text-right">Retours</TableHead>
          <TableHead className="text-right">Taux livr.</TableHead>
          <TableHead className="text-right">Délai moy.</TableHead>
          <TableHead className="text-right">COD en attente</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="font-medium">{r.key}</TableCell>
            <TableCell className="text-right tabular-nums">{r.total}</TableCell>
            <TableCell className="text-right tabular-nums">{r.delivered}</TableCell>
            <TableCell className="text-right tabular-nums">{r.failed}</TableCell>
            <TableCell className="text-right tabular-nums">{r.returned}</TableCell>
            <TableCell className="text-right tabular-nums">{pct(r.successRate)}</TableCell>
            <TableCell className="text-right tabular-nums">{days(r.avgDeliveryDays)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.codPending)}</TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Aucune expédition sur la période.</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}

export default async function RapportLivraisonPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePermission("analytics.view");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const [report, business] = await Promise.all([
    getDeliveryPerformanceReport(resolved.range),
    getReportBusinessInfo(),
  ]);
  const o = report.overall;

  const exportHref = `/rapports/export/livraison?${rangeQuery(resolved)}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport de performance livraison" periodLabel={resolved.label} />
      <PageHeader
        title="Rapport de performance livraison"
        description={`Période : ${resolved.label} — expéditions créées dans la fenêtre.`}
      />
      <ReportFilterBar basePath="/rapports/livraison" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Expéditions" value={String(o.total)} tone="primary" />
        <KpiCard label="Taux de livraison" value={pct(o.successRate)} tone="success"
          hint={`${o.delivered} livrées / ${o.failed} échecs / ${o.returned} retours`} />
        <KpiCard label="Délai moyen de livraison" value={days(o.avgDeliveryDays)} tone="info" />
        <KpiCard label="Coût de livraison total" value={formatCurrency(o.shippingCost)} tone="warning" />
        <KpiCard label="COD encaissé" value={formatCurrency(o.codCollected)} tone="success" />
        <KpiCard label="COD livré mais en attente" value={formatCurrency(o.codPending)} tone="danger"
          hint="Colis livrés dont le paiement n'est pas encore encaissé" />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Par transporteur</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto"><PerfTable rows={report.byProvider} label="Transporteur" /></CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Par ville</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto"><PerfTable rows={report.byCity} label="Ville" /></CardContent>
      </Card>
    </div>
  );
}
