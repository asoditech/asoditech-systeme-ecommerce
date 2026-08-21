import Link from "next/link";
import { Boxes, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { StockAdjustmentDialog } from "@/components/inventory/stock-adjustment-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listInventoryItems } from "@/lib/queries/inventory";

export const metadata = { title: "Stock — ASODITECH Gestion E-commerce" };

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; lowStock?: string; page?: string }>;
}) {
  const user = await requirePermission("inventory.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const lowStockOnly = params.lowStock === "1";
  const { items, total, pageSize } = await listInventoryItems({ q: params.q, lowStockOnly, page });
  const canAdjust = hasPermission(user.role, "inventory.adjust");

  return (
    <div>
      <PageHeader
        title="Stock"
        description="Niveaux de stock par produit et par entrepôt."
        actions={
          <Button variant={lowStockOnly ? "default" : "outline"} render={<Link href={lowStockOnly ? "/stock" : "/stock?lowStock=1"} />}>
            <AlertTriangle className="size-4" />
            {lowStockOnly ? "Voir tout le stock" : "Stock faible uniquement"}
          </Button>
        }
      />

      <form className="mb-4 flex gap-2" action="/stock">
        <Input name="q" placeholder="Rechercher par produit ou SKU..." defaultValue={params.q} className="max-w-sm" />
        {lowStockOnly && <input type="hidden" name="lowStock" value="1" />}
        <Button type="submit" variant="outline">
          Rechercher
        </Button>
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={lowStockOnly ? "Aucun produit en stock faible." : "Aucun enregistrement de stock."}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produit</TableHead>
                <TableHead>Entrepôt</TableHead>
                <TableHead>Disponible</TableHead>
                <TableHead>Réservé</TableHead>
                <TableHead>Endommagé</TableHead>
                {canAdjust && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => {
                const product = i.product ?? i.variation?.product;
                const threshold = product?.lowStockThreshold ?? 0;
                const isLow = i.quantityOnHand <= threshold;
                const label = i.variation
                  ? `${i.variation.product.name} (${Object.values(i.variation.attributes as Record<string, string>).join(", ")})`
                  : (product?.name ?? "—");
                return (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">
                      {label}
                      {isLow && (
                        <Badge variant="destructive" className="ml-2">
                          Stock faible
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{i.warehouse.name}</TableCell>
                    <TableCell className={isLow ? "font-medium text-destructive" : ""}>{i.quantityOnHand}</TableCell>
                    <TableCell>{i.quantityReserved}</TableCell>
                    <TableCell>{i.quantityDamaged}</TableCell>
                    {canAdjust && (
                      <TableCell>
                        <StockAdjustmentDialog
                          productId={i.productId ?? undefined}
                          variationId={i.variationId ?? undefined}
                          warehouseId={i.warehouseId}
                          label={label}
                        />
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/stock"
            searchParams={{ q: params.q, lowStock: params.lowStock }}
          />
        </div>
      )}
    </div>
  );
}
