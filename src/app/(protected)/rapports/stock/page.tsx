import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { WarehousePickerLink } from "@/components/reports/warehouse-picker-link";
import { requirePermission } from "@/lib/auth/guards";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import { resolveReportRange } from "@/lib/reports/range";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { listAccessibleActiveWarehouses, hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Valorisation du stock — ASODITECH Gestion E-commerce" };

const money = (v: number | null) => (v === null ? "—" : formatCurrency(v));

export default async function RapportStockPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string; warehouseId?: string }>;
}) {
  const user = await requirePermission("analytics.view");
  const params = await searchParams;
  const resolved = resolveReportRange({});
  // Location Access Management v1 (docs/adr/0037): the picker only ever
  // offers warehouses this user is authorized for — a forged
  // `?warehouseId=` for one outside that set simply doesn't match here and
  // falls through to "no filter", which itself is scoped below.
  const warehouses = await listAccessibleActiveWarehouses(user);
  const warehouseId = warehouses.find((w) => w.id === params.warehouseId)?.id;

  const [report, business] = await Promise.all([
    getStockValuationReport({
      warehouseId,
      // No explicit selection: OWNER/ADMIN still see the whole tenant;
      // everyone else is restricted to their own authorized warehouses,
      // never the tenant's full stock, server-side.
      warehouseIds: !warehouseId && !hasGlobalLocationAccess(user.role) ? warehouses.map((w) => w.id) : undefined,
      // Rotation counts every activity the viewer may read — and none they may
      // not (docs/adr/0039): Online orders need an ONLINE channel, in-store
      // sales are restricted to the viewer's own store channels.
      includeOnlineOrders: user.channels.online,
      offlineSaleScope: user.channels.offline ? saleChannelWhere(user) : null,
    }),
    getReportBusinessInfo(),
  ]);
  const { totals } = report;

  const exportParams = new URLSearchParams();
  if (warehouseId) exportParams.set("warehouseId", warehouseId);

  return (
    <div>
      <ReportDocumentHeader business={business} title="Valorisation du stock" periodLabel="stock actuel" />
      <PageHeader
        title="Valorisation & rotation du stock"
        description="Photo du stock actuel — valeur au coût et au prix de vente, et articles qui ne tournent pas."
      />
      <ReportFilterBar
        basePath="/rapports/stock"
        resolved={resolved}
        hidePeriod
        exportHref={`/rapports/export/stock?${exportParams.toString()}`}
        extraParams={{ warehouseId }}
        extra={
          warehouses.length > 1 ? (
            <WarehousePickerLink warehouses={warehouses} selected={warehouseId} basePath="/rapports/stock" />
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Valeur au coût" value={money(totals.valueAtCost)} unavailableReason="Coûts manquants" tone="primary"
          hint={totals.linesMissingCost > 0 ? `${totals.linesMissingCost} article(s) sans coût` : undefined} />
        <KpiCard label="Valeur au prix de vente" value={formatCurrency(totals.valueAtRetail)} tone="info" />
        <KpiCard label="Marge potentielle" value={money(totals.potentialMargin)} tone="success" />
        <KpiCard label="Références en stock" value={String(totals.skuCount)} tone="violet"
          hint={`${totals.unitsOnHand} unités`} />
        <KpiCard label={`Articles dormants (${report.dormantDays} j)`} value={String(totals.dormantSkuCount)} tone="warning"
          hint={totals.dormantValueAtCost !== null ? `${formatCurrency(totals.dormantValueAtCost)} immobilisés` : undefined} />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Détail par article</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>Entrepôt</TableHead>
                <TableHead>Produit</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qté</TableHead>
                <TableHead className="text-right">Valeur au coût</TableHead>
                <TableHead className="text-right">Valeur au PV</TableHead>
                <TableHead className="text-right">Ventes {report.dormantDays} j</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r, i) => (
                <TableRow key={`${r.sku}-${i}`} className={r.dormant ? "bg-amber-500/5" : undefined}>
                  <TableCell className="text-muted-foreground">{r.warehouseName}</TableCell>
                  <TableCell className="font-medium">
                    {r.productName}
                    {r.variantLabel && <span className="ml-1 text-xs text-muted-foreground">— {r.variantLabel}</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.quantityOnHand}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.valueAtCost)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.valueAtRetail)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.unitsSoldInWindow}</TableCell>
                </TableRow>
              ))}
              {report.rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Aucun stock enregistré.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
