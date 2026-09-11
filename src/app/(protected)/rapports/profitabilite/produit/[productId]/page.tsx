import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getProfitabilityReport, listOrdersForProduct, DELETED_PRODUCT_KEY } from "@/lib/queries/reports/profitability";
import { formatCurrency, formatDate, formatOrderNumber } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Profitabilité produit — ASODITECH Gestion E-commerce" };

const money = (v: number | null) => (v === null ? "—" : formatCurrency(v));
const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const PAGE_SIZE = 20;

export default async function ProfitabiliteProduitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string; page?: string }>;
}) {
  await requirePermission("analytics.view");
  const { productId: rawId } = await params;
  const productId = rawId === DELETED_PRODUCT_KEY ? null : rawId;
  const sp = await searchParams;
  const resolved = resolveReportRange(sp);
  const page = Math.max(1, Number(sp.page) || 1);

  const report = await getProfitabilityReport(resolved.range);
  const row = report.byProduct.find((r) => (r.productId ?? DELETED_PRODUCT_KEY) === rawId);
  if (!row) notFound();

  const { rows: orders, total } = await listOrdersForProduct(productId, resolved.range, page, PAGE_SIZE);

  return (
    <div>
      <PageHeader
        title={row.name}
        breadcrumbs={[
          { label: "Rapports", href: "/rapports" },
          { label: "Profitabilité", href: "/rapports/profitabilite" },
          { label: row.name },
        ]}
        description={`Période : ${resolved.label} — détail des commandes ayant contribué à ce produit.`}
      />
      <ReportFilterBar basePath={`/rapports/profitabilite/produit/${rawId}`} resolved={resolved} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Quantité vendue" value={String(row.unitsSold)} tone="primary" />
        <KpiCard label="CA" value={formatCurrency(row.revenue)} tone="primary" />
        <KpiCard label="Coût produits" value={row.productCost !== null ? formatCurrency(row.productCost) : null}
          unavailableReason="Coût manquant" tone="warning" />
        <KpiCard label="Frais de livraison" value={formatCurrency(row.deliveryCost)} tone="info" />
        <KpiCard label="Profit" value={row.profit !== null ? formatCurrency(row.profit) : null}
          unavailableReason="Non calculable" tone="success" />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">Marge : {pct(row.marginPct)}</p>

      {!row.dataComplete && (
        <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          Données incomplètes : {row.linesMissingCost} ligne{row.linesMissingCost > 1 ? "s" : ""} sans coût enregistré.
        </p>
      )}

      <Card className="mt-6">
        <CardHeader><CardTitle>Commandes contributrices</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Qté</TableHead>
                <TableHead className="text-right">CA</TableHead>
                <TableHead className="text-right">Coût produits</TableHead>
                <TableHead className="text-right">Frais de livraison</TableHead>
                <TableHead className="text-right">Profit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <ClickableTableRow key={o.orderId} href={`/commandes/${o.orderId}`}>
                  <TableCell className="font-medium">{formatOrderNumber(o.displayNumber)}</TableCell>
                  <TableCell>{o.customerName}</TableCell>
                  <TableCell>{formatDate(o.placedAt)}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{o.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(o.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.productCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(o.deliveryCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.profit)}</TableCell>
                </ClickableTableRow>
              ))}
              {orders.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Aucune commande.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            basePath={`/rapports/profitabilite/produit/${rawId}`}
            searchParams={{ ...resolved.params, page: String(page) } as Record<string, string | undefined>}
          />
        </CardContent>
      </Card>

      <p className="mt-4 print:hidden">
        <Link href={`/rapports/profitabilite?${rangeQuery(resolved)}`} className="text-sm text-primary hover:underline">
          ← Retour au rapport de profitabilité
        </Link>
      </p>
    </div>
  );
}
