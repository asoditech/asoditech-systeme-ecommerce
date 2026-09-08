import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getCashflowReport } from "@/lib/queries/reports/cashflow";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Rapport de trésorerie — ASODITECH Gestion E-commerce" };

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);

export default async function RapportTresoreriePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePermission("finance.view");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const [r, business] = await Promise.all([
    getCashflowReport(resolved.range),
    getReportBusinessInfo(),
  ]);

  const exportHref = `/rapports/export/tresorerie?${rangeQuery(resolved)}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport de trésorerie" periodLabel={resolved.label} />
      <PageHeader
        title="Rapport de trésorerie"
        description={`Période : ${resolved.label} — encaissements attendus vs sorties. Vue caisse, pas comptable.`}
      />
      <ReportFilterBar basePath="/rapports/tresorerie" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Encaissé" value={formatCurrency(r.inflows.collected)} tone="success" />
        <KpiCard label="À encaisser" value={formatCurrency(r.inflows.pending)} tone="warning"
          hint="Commandes non encore payées (COD en attente)" />
        <KpiCard label="Sorties (dépenses + livraison)" value={formatCurrency(r.outflows.total)} tone="danger" />
        <KpiCard label="Trésorerie nette" value={formatCurrency(r.netCash)}
          tone={r.netCash >= 0 ? "success" : "danger"} hint={`Projetée : ${formatCurrency(r.projectedNet)}`} />
        <KpiCard label="Marge brute %" value={pct(r.grossMarginPct)} tone="primary" />
        <KpiCard label="Remboursé" value={formatCurrency(r.inflows.refunded)} tone="warning" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Encaissements par mode de paiement</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table className="text-[13px]">
              <TableHeader><TableRow><TableHead>Mode</TableHead><TableHead className="text-right">Encaissé</TableHead><TableHead className="text-right">À encaisser</TableHead></TableRow></TableHeader>
              <TableBody>
                {r.inflows.byMethod.map((m) => (
                  <TableRow key={m.method}>
                    <TableCell>{m.method}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(m.collected)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(m.pending)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Sorties par poste</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <Table className="text-[13px]">
              <TableHeader><TableRow><TableHead>Poste</TableHead><TableHead className="text-right">Montant</TableHead></TableRow></TableHeader>
              <TableBody>
                {r.outflows.expensesByCategory.map((e) => (
                  <TableRow key={e.category}>
                    <TableCell>{e.category}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(e.amount)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell>Frais de livraison</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.outflows.deliveryCost)}</TableCell>
                </TableRow>
                <TableRow className="font-medium">
                  <TableCell>Total des sorties</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.outflows.total)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
