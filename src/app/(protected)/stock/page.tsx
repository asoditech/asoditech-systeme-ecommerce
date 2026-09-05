import Link from "next/link";
import { Boxes } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { StockAdjustmentDialog } from "@/components/inventory/stock-adjustment-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listInventoryItems, listWarehousesWithStats, type StockStatusFilter, type InventorySort } from "@/lib/queries/inventory";
import { listCategories } from "@/lib/queries/products";
import { availableStock } from "@/lib/inventory";

export const metadata = { title: "Stock — ASODITECH Gestion E-commerce" };

const STOCK_STATUS_LABELS: Record<StockStatusFilter, string> = {
  all: "Tous",
  low: "Stock faible",
  out: "Rupture de stock",
};

const SORT_LABELS: Record<InventorySort, string> = {
  recent: "Plus récent",
  "quantity-asc": "Quantité croissante",
  "quantity-desc": "Quantité décroissante",
};

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    warehouseId?: string;
    categoryId?: string;
    stockStatus?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("inventory.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const [warehouses, categories] = await Promise.all([listWarehousesWithStats(), listCategories()]);

  const stockStatus: StockStatusFilter =
    params.stockStatus === "low" || params.stockStatus === "out" ? params.stockStatus : "all";
  const warehouseId = warehouses.some((w) => w.id === params.warehouseId) ? params.warehouseId : undefined;
  const categoryId = categories.some((c) => c.id === params.categoryId) ? params.categoryId : undefined;
  const sort: InventorySort =
    params.sort === "quantity-asc" || params.sort === "quantity-desc" ? params.sort : "recent";

  const { items, total, pageSize } = await listInventoryItems({
    q: params.q,
    warehouseId,
    categoryId,
    stockStatus,
    sort,
    page,
  });
  const canAdjust = hasPermission(user.role, "inventory.adjust");

  const hasActiveFilter = Boolean(params.q || warehouseId || categoryId || stockStatus !== "all" || params.sort);
  const paginationParams = { q: params.q, warehouseId, categoryId, stockStatus: params.stockStatus, sort: params.sort };

  return (
    <div>
      <PageHeader title="Stock" description="Niveaux de stock par produit et par entrepôt." />

      <form className="mb-4 flex flex-wrap gap-2" action="/stock">
        <Input name="q" placeholder="Rechercher par produit ou SKU..." defaultValue={params.q} className="max-w-56" />
        <Select name="warehouseId" defaultValue={warehouseId || "all"}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Emplacement">
              {warehouseId ? (warehouses.find((w) => w.id === warehouseId)?.name ?? "Emplacement") : "Tous les emplacements"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les emplacements</SelectItem>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="categoryId" defaultValue={categoryId || "all"}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Catégorie">
              {categoryId ? (categories.find((c) => c.id === categoryId)?.name ?? "Catégorie") : "Toutes catégories"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes catégories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="stockStatus" defaultValue={stockStatus}>
          <SelectTrigger className="w-44">
            <SelectValue>{STOCK_STATUS_LABELS[stockStatus]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STOCK_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="sort" defaultValue={sort}>
          <SelectTrigger className="w-48">
            <SelectValue>{SORT_LABELS[sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline">
          Filtrer
        </Button>
        {hasActiveFilter ? (
          <Button variant="ghost" render={<Link href="/stock" />}>
            Réinitialiser
          </Button>
        ) : null}
      </form>

      {items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={
            hasActiveFilter ? "Aucun produit ne correspond à ces critères." : "Aucun enregistrement de stock."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produit</TableHead>
                <TableHead>Emplacement</TableHead>
                <TableHead>Stock physique</TableHead>
                <TableHead>Réservé</TableHead>
                <TableHead>Disponible</TableHead>
                <TableHead>Endommagé</TableHead>
                {canAdjust && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => {
                const product = i.product ?? i.variation?.product;
                const threshold = product?.lowStockThreshold ?? 0;
                const isLow = i.quantityOnHand <= threshold;
                const isOut = availableStock(i) <= 0;
                const label = i.variation
                  ? `${i.variation.product.name} (${Object.values(i.variation.attributes as Record<string, string>).join(", ")})`
                  : (product?.name ?? "—");
                return (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">
                      {product ? (
                        <Link href={`/produits/${product.id}`} className="hover:underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      {isOut ? (
                        <Badge variant="destructive" className="ml-2">
                          Rupture
                        </Badge>
                      ) : (
                        isLow && (
                          <Badge variant="destructive" className="ml-2">
                            Stock faible
                          </Badge>
                        )
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{i.warehouse.name}</TableCell>
                    <TableCell className={isLow ? "font-medium text-destructive" : ""}>{i.quantityOnHand}</TableCell>
                    <TableCell>{i.quantityReserved}</TableCell>
                    <TableCell>{availableStock(i)}</TableCell>
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
            searchParams={paginationParams}
          />
        </div>
      )}
    </div>
  );
}
