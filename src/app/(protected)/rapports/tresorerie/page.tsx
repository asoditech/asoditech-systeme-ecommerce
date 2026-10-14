import { PageHeader } from "@/components/page-header";
import { MissingCostBanner } from "@/components/catalog-health/missing-cost-banner";
import { KpiCard } from "@/components/kpi-card";
import { ReportMetricInfo } from "@/components/reports/report-metric-info";
import { ReportDefinitions } from "@/components/reports/report-definitions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { resolveTenantReportRange, rangeQuery } from "@/lib/reports/range";
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
  const viewer = await requirePermission("finance.view");
  // Order-derived data: needs an ONLINE channel (docs/adr/0039).
  requireChannelKind(viewer, "ONLINE");
  const params = await searchParams;
  const resolved = await resolveTenantReportRange(params);
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
      <MissingCostBanner user={viewer} />
      <ReportFilterBar basePath="/rapports/tresorerie" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Encaissé" explain={<ReportMetricInfo metric="cashCollected" label="Encaissé" className="-ml-1" />} value={formatCurrency(r.inflows.collected)} tone="success" />
        <KpiCard label="À encaisser" explain={<ReportMetricInfo metric="cashPending" label="À encaisser" className="-ml-1" />} value={formatCurrency(r.inflows.pending)} tone="warning"
          hint={
            r.inflows.pendingPartial > 0
              ? `Commandes en cours non payées — dont ${formatCurrency(r.inflows.pendingPartial)} partiellement payées, comptées en entier`
              : "Commandes en cours non encore payées (hors annulées, échecs, retours)"
          } />
        <KpiCard label="Sorties (dépenses + livraison)" explain={<ReportMetricInfo metric="cashOutflows" label="Sorties (dépenses + livraison)" className="-ml-1" />} value={formatCurrency(r.outflows.total)} tone="danger" />
        <KpiCard label="Trésorerie nette" explain={<ReportMetricInfo metric="cashNet" label="Trésorerie nette" className="-ml-1" />} value={formatCurrency(r.netCash)}
          tone={r.netCash >= 0 ? "success" : "danger"} hint={`Projetée : ${formatCurrency(r.projectedNet)}`} />
        <KpiCard label="Marge brute %" explain={<ReportMetricInfo metric="cashGrossMargin" label="Marge brute %" className="-ml-1" />} value={pct(r.grossMarginPct)} tone="primary" />
        <KpiCard label="Remboursé" explain={<ReportMetricInfo metric="cashRefunded" label="Remboursé" className="-ml-1" />} value={formatCurrency(r.inflows.refunded)} tone="warning" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle accent="green">Encaissements par mode de paiement<ReportMetricInfo metric="cashByMethod" /></CardTitle></CardHeader>
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
          <CardHeader><CardTitle accent="green">Sorties par poste<ReportMetricInfo metric="cashOutflowsByCategory" /></CardTitle></CardHeader>
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
      <ReportDefinitions report="tresorerie" />
    </div>
  );
}
