import Link from "next/link";
import { Boxes, Download, Warehouse } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { StockAdjustmentDialog } from "@/components/inventory/stock-adjustment-dialog";
import { ProductImagePreview } from "@/components/products/product-image-preview";
import { unitImageUrl } from "@/lib/catalog/unit-image";
import { SyncRefreshButton } from "@/components/sync-refresh-button";
import { getConnectedCommercePlatforms } from "@/lib/integrations/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { ProductThumb } from "@/components/products/product-thumb";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listAccessibleActiveWarehouses, hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { listInventoryItems, listWarehousesWithStats, type StockStatusFilter, type InventorySort } from "@/lib/queries/inventory";
import { listCategories } from "@/lib/queries/products";
import { availableStock } from "@/lib/inventory";
import { describeLocationCost } from "@/lib/catalog/location-cost";
import { LocationCostDisplay } from "@/components/inventory/location-cost-display";

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

  const [allWarehouses, categories] = await Promise.all([listWarehousesWithStats(), listCategories()]);
  // Location Access Management v1 (docs/adr/0037): OWNER/ADMIN keep seeing
  // every active-or-not warehouse (unchanged); everyone else's picker (and
  // the underlying query below) is restricted to their own authorized set —
  // never "every warehouse in the tenant" just because they hold
  // `inventory.view`. Batch 15: this page and its CSV export previously had
  // no such scoping at all.
  const isGlobal = hasGlobalLocationAccess(user.role);
  const accessibleIds = isGlobal ? null : new Set((await listAccessibleActiveWarehouses(user)).map((w) => w.id));
  const warehouses = isGlobal ? allWarehouses : allWarehouses.filter((w) => accessibleIds!.has(w.id));

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
    allowedWarehouseIds: isGlobal ? null : warehouses.map((w) => w.id),
  });
  const canAdjust = userHasPermission(user, "inventory.adjust");
  // Purchase cost is finance.view data (docs/adr/0043): the column — and every
  // cost value — is rendered only for those users. Read from the rows already
  // loaded (InventoryItem.currentUnitCost + product/variation cost): no extra query.
  const canViewCost = userHasPermission(user, "finance.view");
  const canSync =
    userHasPermission(user, "integrations.manage") && (await getConnectedCommercePlatforms()).length > 0;

  const hasActiveFilter = Boolean(params.q || warehouseId || categoryId || stockStatus !== "all" || params.sort);
  const paginationParams = { q: params.q, warehouseId, categoryId, stockStatus: params.stockStatus, sort: params.sort };
  // Same filters as the visible table, so the download always matches what's on screen.
  const exportParams = new URLSearchParams();
  if (params.q) exportParams.set("q", params.q);
  if (warehouseId) exportParams.set("warehouseId", warehouseId);
  if (categoryId) exportParams.set("categoryId", categoryId);
  if (stockStatus !== "all") exportParams.set("stockStatus", stockStatus);
  if (params.sort) exportParams.set("sort", params.sort);

  return (
    <div>
      <PageHeader
        title="Stock"
        description="Niveaux de stock par produit et par entrepôt."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" render={<a href={`/stock/export?${exportParams.toString()}`} />}>
              <Download className="size-4" />
              Exporter (CSV)
            </Button>
            <SyncRefreshButton resource="products" canSync={canSync} />
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSearchInput placeholder="Produit ou SKU..." defaultValue={params.q} className="w-56" />
        <FilterSelect
          paramKey="warehouseId"
          value={warehouseId}
          allLabel="Tous les emplacements"
          ariaLabel="Emplacement"
          className="w-48"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect
          paramKey="categoryId"
          value={categoryId}
          allLabel="Toutes catégories"
          ariaLabel="Catégorie"
          className="w-44"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          paramKey="stockStatus"
          value={stockStatus !== "all" ? stockStatus : undefined}
          allLabel={STOCK_STATUS_LABELS.all}
          ariaLabel="Statut de stock"
          className="w-44"
          options={[
            { value: "low", label: STOCK_STATUS_LABELS.low },
            { value: "out", label: STOCK_STATUS_LABELS.out },
          ]}
        />
        <FilterSelect
          paramKey="sort"
          value={params.sort === "quantity-asc" || params.sort === "quantity-desc" ? params.sort : undefined}
          allLabel={SORT_LABELS.recent}
          ariaLabel="Trier"
          className="w-48"
          options={[
            { value: "quantity-asc", label: SORT_LABELS["quantity-asc"] },
            { value: "quantity-desc", label: SORT_LABELS["quantity-desc"] },
          ]}
        />
        {hasActiveFilter ? (
          <Button size="sm" variant="ghost" render={<Link href="/stock" />}>
            Réinitialiser
          </Button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={
            hasActiveFilter ? "Aucun produit ne correspond à ces critères." : "Aucun enregistrement de stock."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produit</TableHead>
                <TableHead>Emplacement</TableHead>
                <TableHead className="text-right">Physique</TableHead>
                <TableHead className="text-right">Réservé</TableHead>
                <TableHead className="text-right">Disponible</TableHead>
                <TableHead className="text-right">Endommagé</TableHead>
                <TableHead>État</TableHead>
                {canViewCost && <TableHead className="text-right">Coût d&apos;achat</TableHead>}
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
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <ProductImagePreview imageUrl={unitImageUrl(i.variation, product?.images[0]?.url)} name={label}>
                          <ProductThumb imageUrl={unitImageUrl(i.variation, product?.images[0]?.url)} className="size-9" />
                        </ProductImagePreview>
                        <div className="min-w-0">
                          {product ? (
                            <Link href={`/produits/${product.id}`} className="font-semibold hover:text-primary hover:underline">
                              {product.name}
                            </Link>
                          ) : (
                            <span className="font-semibold">{label}</span>
                          )}
                          {i.variation && (
                            <p className="text-xs text-muted-foreground">
                              {Object.values(i.variation.attributes as Record<string, string>).join(" · ")}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <Warehouse className="size-3.5" />
                        {i.warehouse.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{i.quantityOnHand}</TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">{i.quantityReserved}</TableCell>
                    <TableCell className="text-right text-base font-semibold tabular-nums">{availableStock(i)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", i.quantityDamaged > 0 ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
                      {i.quantityDamaged}
                    </TableCell>
                    <TableCell>
                      {isOut ? (
                        <Badge variant="destructive">Rupture</Badge>
                      ) : isLow ? (
                        <Badge variant="warning">Stock faible</Badge>
                      ) : (
                        <Badge variant="success">En stock</Badge>
                      )}
                    </TableCell>
                    {canViewCost && (
                      <TableCell className="text-right">
                        {(() => {
                          const { cost, source } = describeLocationCost(i.currentUnitCost, i.variation?.cost, product?.cost);
                          return <LocationCostDisplay cost={cost?.toString() ?? null} source={source} />;
                        })()}
                      </TableCell>
                    )}
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
