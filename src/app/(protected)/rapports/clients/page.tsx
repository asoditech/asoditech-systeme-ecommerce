import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getCustomerReport } from "@/lib/queries/reports/customers";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Rapport clients — ASODITECH Gestion E-commerce" };

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const money = (v: number | null) => (v === null ? "—" : formatCurrency(v));

export default async function RapportClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePermission("analytics.view");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const [report, business] = await Promise.all([
    getCustomerReport(resolved.range),
    getReportBusinessInfo(),
  ]);
  const t = report.totals;

  const exportHref = `/rapports/export/clients?${rangeQuery(resolved)}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport clients" periodLabel={resolved.label} />
      <PageHeader
        title="Rapport clients"
        description={`Période : ${resolved.label} — clients ayant commandé dans la fenêtre.`}
      />
      <ReportFilterBar basePath="/rapports/clients" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Clients acheteurs" value={String(t.distinctBuyers)} tone="primary" />
        <KpiCard label="Nouveaux clients" value={String(t.newCustomers)} tone="info"
          hint={`${money(t.revenueFromNew)} de CA`} />
        <KpiCard label="Clients récurrents" value={String(t.returningCustomers)} tone="success"
          hint={`${money(t.revenueFromReturning)} de CA`} />
        <KpiCard label="Taux de réachat" value={pct(t.repeatRatePct)} tone="violet" />
        <KpiCard label="Commandes / client" value={t.avgOrdersPerBuyer !== null ? t.avgOrdersPerBuyer.toFixed(1) : null} tone="primary" />
        <KpiCard label="CA / client" value={money(t.avgRevenuePerBuyer)} tone="primary" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Meilleurs clients</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table className="text-[13px]">
              <TableHeader><TableRow><TableHead>Client</TableHead><TableHead>Ville</TableHead><TableHead className="text-right">Cmd</TableHead><TableHead className="text-right">CA</TableHead></TableRow></TableHeader>
              <TableBody>
                {report.topCustomers.map((c) => (
                  <TableRow key={c.customerId}>
                    <TableCell className="font-medium">{c.name}{c.isNew && <span className="ml-1.5 rounded bg-cyan-500/10 px-1 text-[10px] text-cyan-600 dark:text-cyan-400">nouveau</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{c.city ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(c.revenue)}</TableCell>
                  </TableRow>
                ))}
                {report.topCustomers.length === 0 && (
                  <TableRow><TableCell colSpan={4} className="text-center text-muted-foreground">Aucune commande sur la période.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Par ville</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table className="text-[13px]">
              <TableHeader><TableRow><TableHead>Ville</TableHead><TableHead className="text-right">Acheteurs</TableHead><TableHead className="text-right">Cmd</TableHead><TableHead className="text-right">CA</TableHead></TableRow></TableHeader>
              <TableBody>
                {report.byCity.map((r) => (
                  <TableRow key={r.city}>
                    <TableCell>{r.city}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.buyers}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
