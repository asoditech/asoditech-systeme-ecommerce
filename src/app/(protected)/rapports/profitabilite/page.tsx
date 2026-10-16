import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { PageHeader } from "@/components/page-header";
import { MissingCostBanner } from "@/components/catalog-health/missing-cost-banner";
import { KpiCard } from "@/components/kpi-card";
import { ReportMetricInfo } from "@/components/reports/report-metric-info";
import { ReportDefinitions } from "@/components/reports/report-definitions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportOnlineChannelFilter } from "@/components/reports/report-online-channel-filter";
import { resolveReportOnlineChannel, reportOrderScope } from "@/lib/reports/online-channel";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { resolveTenantReportRange, rangeQuery } from "@/lib/reports/range";
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

/**
 * « Par campagne / source » is hidden for now: nothing records an order's
 * campaign yet (Order.campaignId is never written — /marketing is hidden
 * too), so that view could only show one « Sans campagne » row. The query,
 * the CampaignTable and the drill-down route are kept; set this to `true`
 * once campaign attribution exists.
 */
const CAMPAIGN_VIEW_AVAILABLE: boolean = false;

/** `null` → the "sans produit / sans campagne" bucket's URL segment. `query`
 * carries the period AND the « Canal en ligne » scope, so the drill-down
 * shows the same population as the row that was clicked. */
const productHref = (productId: string | null, query: string) => `/rapports/profitabilite/produit/${productId ?? DELETED_PRODUCT_KEY}${query ? `?${query}` : ""}`;
const campaignHref = (campaignId: string | null, query: string) => `/rapports/profitabilite/campagne/${campaignId ?? NO_CAMPAIGN_KEY}${query ? `?${query}` : ""}`;

function IncompleteBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 text-xs text-pill-yellow-fg">
      ({count} ligne{count > 1 ? "s" : ""} sans coût)
    </span>
  );
}

function ProductTable({ rows, query }: { rows: ProductProfitabilityRow[]; query: string }) {
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
          <ClickableTableRow key={r.key} href={productHref(r.productId, query)}>
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

function CampaignTable({ rows, query }: { rows: CampaignProfitabilityRow[]; query: string }) {
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
          <ClickableTableRow key={r.key} href={campaignHref(r.campaignId, query)}>
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
  searchParams: Promise<{ period?: string; from?: string; to?: string; canal?: string; view?: string }>;
}) {
  const viewer = await requirePermission("analytics.view");
  // Margins, cost of goods and profit are finance data (docs/adr/0050).
  await requirePermission("finance.view");
  // Order-derived data: needs an ONLINE channel (docs/adr/0039).
  requireChannelKind(viewer, "ONLINE");
  const params = await searchParams;
  const resolved = await resolveTenantReportRange(params);
  // « Canal en ligne » (only the viewer's own channels; see resolveReportOnlineChannel).
  const channelFilter = await resolveReportOnlineChannel(viewer, params.canal);
  const scope = reportOrderScope(channelFilter.salesChannelId);
  const view = CAMPAIGN_VIEW_AVAILABLE && params.view === "campagne" ? "campagne" : "produit";
  const [report, business] = await Promise.all([
    getProfitabilityReport(resolved.range, scope),
    getReportBusinessInfo(),
  ]);
  const { totals } = report;

  const exportHref = `/rapports/export/profitabilite?${rangeQuery(resolved, { canal: channelFilter.salesChannelId })}`;
  const drillQuery = rangeQuery(resolved, { canal: channelFilter.salesChannelId });
  const viewHref = (v: "produit" | "campagne") => `/rapports/profitabilite?${rangeQuery(resolved, { view: v, canal: channelFilter.salesChannelId })}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport de profitabilité" periodLabel={resolved.label} />
      <PageHeader
        title="Profitabilité"
        description={`Période : ${resolved.label} — CA, coût des produits (coût figé à la vente) et frais de livraison attribués, par produit${CAMPAIGN_VIEW_AVAILABLE ? " et par campagne/source" : ""}.`}
      />
      <MissingCostBanner user={viewer} />
      <ReportFilterBar
        basePath="/rapports/profitabilite"
        resolved={resolved}
        exportHref={exportHref}
        extraParams={{ view, canal: channelFilter.salesChannelId }}
        extra={<ReportOnlineChannelFilter channels={channelFilter.channels} value={channelFilter.salesChannelId} />}
      />

      {/* 3 columns up to 2xl: five money tiles side by side truncated « 2.050,00 … » at 1440 px. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <KpiCard label="CA produits" explain={<ReportMetricInfo metric="profitRevenue" label="CA produits" className="-ml-1" />} value={formatCurrency(totals.revenue)} tone="primary" />
        <KpiCard label="Coût produits" explain={<ReportMetricInfo metric="profitProductCost" label="Coût produits" className="-ml-1" />} value={totals.productCost !== null ? formatCurrency(totals.productCost) : null}
          unavailableReason="Coût manquant" tone="warning" />
        <KpiCard label="Frais de livraison" explain={<ReportMetricInfo metric="profitDeliveryCost" label="Frais de livraison" className="-ml-1" />} value={formatCurrency(totals.deliveryCost)} tone="info" />
        <KpiCard label="Profit" explain={<ReportMetricInfo metric="profitProfit" label="Profit" className="-ml-1" />} value={totals.profit !== null ? formatCurrency(totals.profit) : null}
          unavailableReason="Non calculable" tone="success" />
        <KpiCard label="Marge" explain={<ReportMetricInfo metric="profitMargin" label="Marge" className="-ml-1" />} value={pct(totals.marginPct)} tone="success" />
      </div>

      {!totals.dataComplete && (
        <p className="mt-3 text-sm text-pill-yellow-fg">
          Données incomplètes : {totals.linesMissingCost} ligne{totals.linesMissingCost > 1 ? "s" : ""} de commande
          {" "}({totals.ordersMissingCost} commande{totals.ordersMissingCost > 1 ? "s" : ""}) n&apos;ont pas de coût
          enregistré — le profit total est indicatif. Renseignez le coût des produits concernés pour un calcul exact.
        </p>
      )}

      {CAMPAIGN_VIEW_AVAILABLE ? (
        <SegmentedControl className="mt-6 mb-5 print:hidden">
          <SegmentedControlItem active={view === "produit"} href={viewHref("produit")}>
            Par produit
          </SegmentedControlItem>
          <SegmentedControlItem active={view === "campagne"} href={viewHref("campagne")}>
            Par campagne / source
          </SegmentedControlItem>
        </SegmentedControl>
      ) : (
        <div className="mt-6" />
      )}

      <Card>
        <CardHeader>
          <CardTitle accent="green">
            {view === "produit" ? "Par produit" : "Par campagne / source"}
            <ReportMetricInfo metric={view === "produit" ? "profitByProduct" : "profitByCampaign"} />
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {view === "produit" ? <ProductTable rows={report.byProduct} query={drillQuery} /> : <CampaignTable rows={report.byCampaign} query={drillQuery} />}
        </CardContent>
      </Card>
      <ReportDefinitions report="profitabilite" exclude={CAMPAIGN_VIEW_AVAILABLE ? [] : ["profitByCampaign"]} />
    </div>
  );
}
