import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { ReportMetricInfo } from "@/components/reports/report-metric-info";
import { ReportDefinitions } from "@/components/reports/report-definitions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportOnlineChannelFilter } from "@/components/reports/report-online-channel-filter";
import { resolveReportOnlineChannel, reportOrderScope } from "@/lib/reports/online-channel";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { resolveTenantReportRange, rangeQuery } from "@/lib/reports/range";
import { getProfitabilityReport, listOrdersForCampaign, NO_CAMPAIGN_KEY } from "@/lib/queries/reports/profitability";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency, formatDate, formatOrderNumber } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Profitabilité campagne — ASODITECH Gestion E-commerce" };

const money = (v: number | null) => (v === null ? "—" : formatCurrency(v));
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const PAGE_SIZE = 20;

export default async function ProfitabiliteCampagneDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string; page?: string; canal?: string }>;
}) {
  const viewer = await requirePermission("analytics.view");
  // Same guards as /rapports/profitabilite: margins and costs are finance
  // data (docs/adr/0050), order-derived data needs an ONLINE channel (docs/adr/0039).
  await requirePermission("finance.view");
  requireChannelKind(viewer, "ONLINE");
  const { campaignId: rawId } = await params;
  const campaignId = rawId === NO_CAMPAIGN_KEY ? null : rawId;
  const sp = await searchParams;
  const resolved = await resolveTenantReportRange(sp);
  const page = Math.max(1, Number(sp.page) || 1);

  // « Canal en ligne » — the parent report's scope, carried by the drill-down
  // link (the viewer's own channels only; a foreign id is ignored).
  const channelFilter = await resolveReportOnlineChannel(viewer, sp.canal);
  const canal = channelFilter.salesChannelId;
  const scope = reportOrderScope(canal);
  const report = await getProfitabilityReport(resolved.range, scope);
  const row = report.byCampaign.find((r) => (r.campaignId ?? NO_CAMPAIGN_KEY) === rawId);
  if (!row) notFound();

  const [{ rows: orders, total }, business] = await Promise.all([
    listOrdersForCampaign(campaignId, resolved.range, page, PAGE_SIZE, scope),
    getReportBusinessInfo(),
  ]);

  return (
    <div>
      <PageHeader
        title={row.name}
        breadcrumbs={[
          { label: "Rapports", href: "/rapports" },
          { label: "Profitabilité", href: `/rapports/profitabilite?${rangeQuery(resolved, { canal })}` },
          { label: row.name },
        ]}
        description={`Période : ${resolved.label} — commandes attribuées à cette campagne / source.`}
      />
      <ReportFilterBar
        basePath={`/rapports/profitabilite/campagne/${rawId}`}
        resolved={resolved}
        extraParams={{ canal }}
        extra={<ReportOnlineChannelFilter channels={channelFilter.channels} value={canal} />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Commandes" explain={<ReportMetricInfo metric="profitCampaignOrders" label="Commandes" className="-ml-1" />} value={String(row.ordersCount)} tone="primary" />
        <KpiCard label="CA produits" explain={<ReportMetricInfo metric="profitRevenue" label="CA produits" className="-ml-1" />} value={formatCurrency(row.revenue)} tone="primary" />
        <KpiCard label="Coût produits" explain={<ReportMetricInfo metric="profitProductCost" label="Coût produits" className="-ml-1" />} value={row.productCost !== null ? formatCurrency(row.productCost) : null}
          unavailableReason="Coût manquant" tone="warning" />
        <KpiCard label="Frais de livraison" explain={<ReportMetricInfo metric="profitDeliveryCost" label="Frais de livraison" className="-ml-1" />} value={formatCurrency(row.deliveryCost)} tone="info" />
        <KpiCard label="Profit" explain={<ReportMetricInfo metric="profitProfit" label="Profit" className="-ml-1" />} value={row.profit !== null ? formatCurrency(row.profit) : null}
          unavailableReason="Non calculable" tone="success" />
      </div>
      <p className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
        Marge : {pct(row.marginPct)}
        <ReportMetricInfo metric="profitMargin" label="Marge" />
      </p>

      {!row.dataComplete && (
        <p className="mt-3 text-sm text-pill-yellow-fg">
          Données incomplètes : {row.linesMissingCost} ligne{row.linesMissingCost > 1 ? "s" : ""} sans coût enregistré.
        </p>
      )}

      <Card className="mt-6">
        <CardHeader><CardTitle accent="green">Commandes contributrices<ReportMetricInfo metric="profitDetailOrders" /></CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">CA</TableHead>
                <TableHead className="text-right">Coût produits</TableHead>
                <TableHead className="text-right">Frais de livraison</TableHead>
                <TableHead className="text-right">Profit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <ClickableTableRow key={o.orderId} href={`/commandes/${o.orderId}`}>
                  <TableCell className="font-medium">{formatOrderNumber(o.displayNumber, business.orderNumberPrefix)}</TableCell>
                  <TableCell>{o.customerName}</TableCell>
                  <TableCell>{formatDate(o.placedAt)}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(o.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.productCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(o.deliveryCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.profit)}</TableCell>
                </ClickableTableRow>
              ))}
              {orders.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Aucune commande.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            basePath={`/rapports/profitabilite/campagne/${rawId}`}
            searchParams={{ ...resolved.params, canal, page: String(page) } as Record<string, string | undefined>}
          />
        </CardContent>
      </Card>

      <p className="mt-4 print:hidden">
        <Link href={`/rapports/profitabilite?${rangeQuery(resolved, { view: "campagne", canal })}`} className="text-link text-sm">
          ← Retour au rapport de profitabilité
        </Link>
      </p>
      <ReportDefinitions report="profitabilite-campagne" />
    </div>
  );
}
