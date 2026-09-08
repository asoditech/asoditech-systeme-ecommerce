import Link from "next/link";
import { Package, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Button } from "@/components/ui/button";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { DisconnectedSourceBanner } from "@/components/integrations/disconnected-source-banner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listProducts, listCategories, type ProductSort, type ProductTypeFilter } from "@/lib/queries/products";
import { formatCurrency } from "@/lib/format";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";
import type { ProductStatus } from "@prisma/client";

export const metadata = { title: "Produits — ASODITECH Gestion E-commerce" };

const SORT_LABELS: Record<ProductSort, string> = {
  recent: "Plus récents",
  name: "Nom (A–Z)",
  "price-asc": "Prix croissant",
  "price-desc": "Prix décroissant",
};

const PRODUCT_TYPE_LABELS: Record<ProductTypeFilter, string> = {
  simple: "Simple",
  variable: "Variante",
};

export default async function ProduitsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    categoryId?: string;
    type?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("products.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const categories = await listCategories();

  const statusFilter =
    params.status && PRODUCT_STATUS_LABELS[params.status] ? (params.status as ProductStatus) : undefined;
  const typeFilter =
    params.type && PRODUCT_TYPE_LABELS[params.type as ProductTypeFilter]
      ? (params.type as ProductTypeFilter)
      : undefined;
  const categoryFilter = categories.find((c) => c.id === params.categoryId)?.id;
  const sortFilter: ProductSort =
    params.sort === "name" || params.sort === "price-asc" || params.sort === "price-desc"
      ? params.sort
      : "recent";

  const { products, total, pageSize } = await listProducts({
    q: params.q,
    status: statusFilter,
    categoryId: categoryFilter,
    type: typeFilter,
    sort: sortFilter,
    page,
  });

  const hasActiveFilter = Boolean(
    params.q || statusFilter || typeFilter || categoryFilter || params.sort
  );
  const paginationParams = {
    q: params.q,
    status: statusFilter,
    categoryId: categoryFilter,
    type: typeFilter,
    sort: params.sort,
  };

  return (
    <div>
      <PageHeader
        title="Produits"
        description="Catalogue produits, prix, coûts et suivi de stock."
        actions={
          hasPermission(user.role, "products.create") ? (
            <Button render={<Link href="/produits/nouveau" />}>
              <Plus className="size-4" />
              Nouveau produit
            </Button>
          ) : undefined
        }
      />

      <DisconnectedSourceBanner entity="product" />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSearchInput placeholder="Nom ou SKU..." defaultValue={params.q} className="w-56" />
        <FilterSelect
          paramKey="status"
          value={statusFilter}
          allLabel="Tous les statuts"
          ariaLabel="Statut"
          className="w-40"
          options={Object.entries(PRODUCT_STATUS_LABELS).map(([value, meta]) => ({ value, label: meta.label }))}
        />
        <FilterSelect
          paramKey="categoryId"
          value={categoryFilter}
          allLabel="Toutes catégories"
          ariaLabel="Catégorie"
          className="w-44"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          paramKey="type"
          value={typeFilter}
          allLabel="Tous types"
          ariaLabel="Type"
          className="w-40"
          options={Object.entries(PRODUCT_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          paramKey="sort"
          value={params.sort && SORT_LABELS[params.sort as ProductSort] ? params.sort : undefined}
          allLabel={SORT_LABELS.recent}
          ariaLabel="Trier"
          className="w-44"
          options={(Object.entries(SORT_LABELS) as [ProductSort, string][])
            .filter(([value]) => value !== "recent")
            .map(([value, label]) => ({ value, label }))}
        />
        {hasActiveFilter ? (
          <Button variant="ghost" size="sm" render={<Link href="/produits" />}>
            Réinitialiser
          </Button>
        ) : null}
      </div>

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title={
            hasActiveFilter
              ? "Aucun produit ne correspond à ces critères."
              : "Aucun produit pour le moment."
          }
          description={hasActiveFilter ? undefined : "Ajoutez votre premier produit pour commencer à vendre."}
          action={
            !hasActiveFilter && hasPermission(user.role, "products.create") ? (
              <Button render={<Link href="/produits/nouveau" />}>Ajouter un produit</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Produit</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Catégorie</TableHead>
                <TableHead>Prix</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Statut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const isVariable = p.variations.length > 0;

                // A variable product keeps no price/stock of its own
                // (WooCommerce puts both on the variations) — aggregate
                // from the variations so the row isn't a misleading
                // "0,00 MAD / Non suivi".
                const variationPrices = p.variations
                  .map((v) => (v.price != null ? Number(v.price) : null))
                  .filter((n): n is number => n != null && n > 0);
                const priceLabel = isVariable
                  ? variationPrices.length > 0
                    ? (() => {
                        const min = Math.min(...variationPrices);
                        const max = Math.max(...variationPrices);
                        return min === max
                          ? formatCurrency(String(min))
                          : `${formatCurrency(String(min))} – ${formatCurrency(String(max))}`;
                      })()
                    : "—"
                  : formatCurrency(p.price.toString());

                const stock = isVariable
                  ? p.variations.reduce(
                      (sum, v) => sum + v.inventoryItems.reduce((s, i) => s + i.quantityOnHand, 0),
                      0
                    )
                  : p.trackInventory
                    ? p.inventoryItems.reduce((sum, i) => sum + i.quantityOnHand, 0)
                    : null;
                const stockTracked = isVariable
                  ? p.variations.some((v) => v.inventoryItems.length > 0)
                  : p.trackInventory;
                const isLow = stock !== null && stockTracked && stock <= p.lowStockThreshold;
                return (
                  <ClickableTableRow key={p.id} href={`/produits/${p.id}`}>
                    <TableCell className="font-medium">
                      {p.name}
                      {isVariable && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          ({p.variations.length} variante{p.variations.length > 1 ? "s" : ""})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.sku}</TableCell>
                    <TableCell className="text-muted-foreground">{p.category?.name ?? "—"}</TableCell>
                    <TableCell>{priceLabel}</TableCell>
                    <TableCell>
                      {stock === null || (isVariable && !stockTracked) ? (
                        <span className="text-muted-foreground">Non suivi</span>
                      ) : (
                        <span className={isLow ? "font-medium text-destructive" : ""}>{stock}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={p.status} labels={PRODUCT_STATUS_LABELS} />
                    </TableCell>
                  </ClickableTableRow>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/produits"
            searchParams={paginationParams}
          />
        </div>
      )}
    </div>
  );
}
