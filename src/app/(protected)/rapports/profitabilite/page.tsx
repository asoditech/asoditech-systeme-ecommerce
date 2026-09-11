import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import {
  getProfitabilityReport,
  DELETED_PRODUCT_KEY,
  NO_CAMPAIGN_KEY,
  type ProductProfitabilityRow,
  type CampaignProfitabilityRow,
} from "@/lib/queries/reports/profitability";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Rapport de profitabilité — ASODITECH Gestion E-commerce" };

const money = (v: number | null) => (v === null ? "—" : formatCurrency(v));
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);

/** `null` → the "sans produit / sans campagne" bucket's URL segment. */
const productHref = (productId: string | null) => `/rapports/profitabilite/produit/${productId ?? DELETED_PRODUCT_KEY}`;
const campaignHref = (campaignId: string | null) => `/rapports/profitabilite/campagne/${campaignId ?? NO_CAMPAIGN_KEY}`;

function IncompleteBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 text-xs text-amber-600 dark:text-amber-400">
      ({count} ligne{count > 1 ? "s" : ""} sans coût)
    </span>
  );
}

function ProductTable({ rows }: { rows: ProductProfitabilityRow[] }) {
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead>Produit</TableHead>
          <TableHead className="text-right">Quantité vendue</TableHead>
          <TableHead className="text-right">CA</TableHead>
          <TableHead className="text-right">Coût produits</TableHead>
          <TableHead className="text-right">Frais de livraison attribués</TableHead>
          <TableHead className="text-right">Profit</TableHead>
          <TableHead className="text-right">Marge %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <ClickableTableRow key={r.key} href={productHref(r.productId)}>
            <TableCell className="font-medium">
              {r.name}
              <IncompleteBadge count={r.linesMissingCost} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{r.unitsSold}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.productCost)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.deliveryCost)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.profit)}</TableCell>
            <TableCell className="text-right tabular-nums">{pct(r.marginPct)}</TableCell>
          </ClickableTableRow>
        ))}
        {rows.length === 0 && (
          <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Aucune vente sur la période.</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function CampaignTable({ rows }: { rows: CampaignProfitabilityRow[] }) {
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead>Campagne / source</TableHead>
          <TableHead className="text-right">Commandes</TableHead>
          <TableHead className="text-right">CA</TableHead>
          <TableHead className="text-right">Coût produits</TableHead>
          <TableHead className="text-right">Frais de livraison</TableHead>
          <TableHead className="text-right">Profit</TableHead>
          <TableHead className="text-right">Marge %</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <ClickableTableRow key={r.key} href={campaignHref(r.campaignId)}>
            <TableCell className="font-medium">
              {r.name}
              <IncompleteBadge count={r.linesMissingCost} />
            </TableCell>
            <TableCell className="text-right tabular-nums">{r.ordersCount}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.productCost)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.deliveryCost)}</TableCell>
            <TableCell className="text-right tabular-nums">{money(r.profit)}</TableCell>
            <TableCell className="text-right tabular-nums">{pct(r.marginPct)}</TableCell>
          </ClickableTableRow>
        ))}
        {rows.length === 0 && (
          <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Aucune commande sur la période.</TableCell></TableRow>
        )}
      </TableBody>
    </Table>
  );
}

export default async function RapportProfitabilitePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string; view?: string }>;
}) {
  await requirePermission("analytics.view");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const view = params.view === "campagne" ? "campagne" : "produit";
  const [report, business] = await Promise.all([
    getProfitabilityReport(resolved.range),
    getReportBusinessInfo(),
  ]);
  const { totals } = report;

  const exportHref = `/rapports/export/profitabilite?${rangeQuery(resolved)}`;
  const viewHref = (v: "produit" | "campagne") => `/rapports/profitabilite?${rangeQuery(resolved, { view: v })}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport de profitabilité" periodLabel={resolved.label} />
      <PageHeader
        title="Profitabilité"
        description={`Période : ${resolved.label} — CA, coût des produits (coût figé à la vente) et frais de livraison attribués, par produit et par campagne/source.`}
      />
      <ReportFilterBar
        basePath="/rapports/profitabilite"
        resolved={resolved}
        exportHref={exportHref}
        extraParams={{ view }}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="CA" value={formatCurrency(totals.revenue)} tone="primary" />
        <KpiCard label="Coût produits" value={totals.productCost !== null ? formatCurrency(totals.productCost) : null}
          unavailableReason="Coût manquant" tone="warning" />
        <KpiCard label="Frais de livraison" value={formatCurrency(totals.deliveryCost)} tone="info" />
        <KpiCard label="Profit" value={totals.profit !== null ? formatCurrency(totals.profit) : null}
          unavailableReason="Non calculable" tone="success" />
        <KpiCard label="Marge" value={pct(totals.marginPct)} tone="success" />
      </div>

      {!totals.dataComplete && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          Données incomplètes : {totals.linesMissingCost} ligne{totals.linesMissingCost > 1 ? "s" : ""} de commande
          {" "}({totals.ordersMissingCost} commande{totals.ordersMissingCost > 1 ? "s" : ""}) n&apos;ont pas de coût
          enregistré — le profit total est indicatif. Renseignez le coût des produits concernés pour un calcul exact.
        </p>
      )}

      <div className="mt-6 mb-4 flex gap-1.5 print:hidden">
        <Button size="sm" variant={view === "produit" ? "default" : "outline"} render={<Link href={viewHref("produit")} />}>
          Par produit
        </Button>
        <Button size="sm" variant={view === "campagne" ? "default" : "outline"} render={<Link href={viewHref("campagne")} />}>
          Par campagne / source
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{view === "produit" ? "Par produit" : "Par campagne / source"}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {view === "produit" ? <ProductTable rows={report.byProduct} /> : <CampaignTable rows={report.byCampaign} />}
        </CardContent>
      </Card>
    </div>
  );
}
