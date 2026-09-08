import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getProductProfitReport, type ProfitRow } from "@/lib/queries/reports/product-profit";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Rapport de rentabilité — ASODITECH Gestion E-commerce" };

const money = (v: number | null) => (v === null ? "—" : formatCurrency(v));
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);

function ProfitTable({ rows, label }: { rows: ProfitRow[]; label: string }) {
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Unités</TableHead>
          <TableHead className="text-right">CA</TableHead>
          <TableHead className="text-right">Coût march.</TableHead>
          <TableHead className="text-right">Marge brute</TableHead>
          <TableHead className="text-right">Marge %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="font-medium">
              {r.name}
              {!r.cogsComplete && (
                <span className="ml-1.5 text-xs text-amber-600 dark:text-amber-400">
                  ({r.linesMissingCost} ligne{r.linesMissingCost > 1 ? "s" : ""} sans coût)
                </span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums">{r.unitsSold}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.cogs)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.grossProfit)}</TableCell>
            <TableCell className="text-right tabular-nums">{pct(r.marginPct)}</TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Aucune vente sur la période.</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}

export default async function RapportRentabilitePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  await requirePermission("analytics.view");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const [report, business] = await Promise.all([
    getProductProfitReport(resolved.range),
    getReportBusinessInfo(),
  ]);
  const { totals } = report;

  const exportHref = `/rapports/export/rentabilite?${rangeQuery(resolved)}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport de rentabilité produit" periodLabel={resolved.label} />
      <PageHeader
        title="Rapport de rentabilité produit"
        description={`Période : ${resolved.label} — marge réalisée sur les coûts figés à la vente (jamais recalculée).`}
      />
      <ReportFilterBar basePath="/rapports/rentabilite" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Chiffre d'affaires" value={formatCurrency(totals.revenue)} tone="primary" />
        <KpiCard label="Coût des marchandises" value={totals.cogs !== null ? formatCurrency(totals.cogs) : null}
          unavailableReason="Coût manquant" tone="warning" />
        <KpiCard label="Marge brute" value={totals.grossProfit !== null ? formatCurrency(totals.grossProfit) : null}
          unavailableReason="Non calculable" tone="success" />
        <KpiCard label="Marge %" value={pct(totals.marginPct)} tone="success" />
      </div>

      {!totals.cogsComplete && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          Certaines lignes de commande n&apos;ont pas de coût enregistré — la marge totale est indicative.
          Renseignez le coût des produits concernés pour une marge exacte.
        </p>
      )}

      <Card className="mt-6">
        <CardHeader><CardTitle>Par catégorie</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto"><ProfitTable rows={report.categories} label="Catégorie" /></CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Par produit</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto"><ProfitTable rows={report.products} label="Produit" /></CardContent>
      </Card>
    </div>
  );
}
