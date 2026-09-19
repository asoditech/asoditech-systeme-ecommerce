import Link from "next/link";
import { Store } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterSearchInput } from "@/components/filter-search-input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { userHasPermission } from "@/lib/auth/permissions";
import { listSales } from "@/lib/queries/sales";
import { displaySaleNumber, formatCurrency, formatDateTime } from "@/lib/format";
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
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>N°</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Emplacement</TableHead>
                <TableHead>Vendeur</TableHead>
                <TableHead>Paiement</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link href={`/ventes/${s.id}`} className="hover:underline">
                      {displaySaleNumber(s)}
                    </Link>
                    {s._count.returns > 0 && <Badge variant="outline" className="ml-2">retour</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(s.soldAt)}</TableCell>
                  <TableCell>{s.salesChannel.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.warehouse.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.soldByName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {[...new Set(s.payments.map((p) => CASH_PAYMENT_METHOD_LABELS[p.method]))].join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatCurrency(s.total.toString(), s.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/ventes" searchParams={{ q: params.q }} />
        </div>
      )}
    </div>
  );
}
