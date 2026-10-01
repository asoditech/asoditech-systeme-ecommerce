import Link from "next/link";
import { Store } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterSearchInput } from "@/components/filter-search-input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { userHasPermission } from "@/lib/auth/permissions";
import { listSales } from "@/lib/queries/sales";
import { displaySaleNumber, formatCurrency, formatDateTime, returnStateLabel } from "@/lib/format";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Ventes magasin — ASODITECH Gestion E-commerce" };

/** In-store sales (docs/adr/0040) — a separate transaction type from delivery orders, row-scoped to the viewer's store channels. */
export default async function VentesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const user = await requirePermission("sales.view");
  requireChannelKind(user, "OFFLINE");
  const params = await searchParams;
  const { sales, total, page, pageSize } = await listSales(user, { q: params.q, page: Number(params.page) || 1 });

  return (
    <div>
      <PageHeader
        title="Ventes magasin"
        description="Ventes réalisées en point de vente. Chaque vente décrémente le stock physique de l'emplacement de vente."
        actions={
          userHasPermission(user, "sales.create") ? (
            <Button render={<Link href="/ventes/nouvelle" />}>
              <Store className="size-4" />
              Nouvelle vente
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4">
        <FilterSearchInput placeholder="Article, code-barres, vendeur, client…" defaultValue={params.q} className="w-72" />
      </div>
      {sales.length === 0 ? (
        <EmptyState icon={Store} title={params.q ? "Aucune vente ne correspond." : "Aucune vente pour le moment."} />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vente</TableHead>
                <TableHead>Point de vente</TableHead>
                <TableHead>Vendeur</TableHead>
                <TableHead>Paiement</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((s) => {
                const returnLabel = returnStateLabel(
                  s.lines.reduce((sum, l) => sum + l.quantity, 0),
                  s.returns.flatMap((r) => r.lines).reduce((sum, l) => sum + l.quantitySellable + l.quantityDamaged, 0)
                );
                return (
                <ClickableTableRow key={s.id} href={`/ventes/${s.id}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link href={`/ventes/${s.id}`} className="font-semibold hover:text-primary hover:underline">
                        {displaySaleNumber(s)}
                      </Link>
                      {returnLabel && <Badge variant="warning">↩ {returnLabel}</Badge>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(s.soldAt)}</p>
                  </TableCell>
                  <TableCell>
                    {/* Canal and emplacement are usually the same store — show
                        the location line only when it actually differs. */}
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Store className="size-3.5 text-muted-foreground" />
                      {s.salesChannel.name}
                    </span>
                    {s.warehouse.name !== s.salesChannel.name && (
                      <p className="mt-0.5 text-xs text-muted-foreground">Stock : {s.warehouse.name}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.soldByName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {[...new Set(s.payments.map((p) => CASH_PAYMENT_METHOD_LABELS[p.method]))].join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(s.total.toString(), s.currency)}</TableCell>
                </ClickableTableRow>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/ventes" searchParams={{ q: params.q }} />
        </div>
      )}
    </div>
  );
}
