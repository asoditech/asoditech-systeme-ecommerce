import Link from "next/link";
import { Package, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listProducts, listCategories, type ProductSort } from "@/lib/queries/products";
import { formatCurrency } from "@/lib/format";
import { PRODUCT_STATUS_LABELS, RECORD_SOURCE_LABELS } from "@/lib/status-labels";
import type { ProductStatus, RecordSource } from "@prisma/client";

export const metadata = { title: "Produits — ASODITECH Gestion E-commerce" };

const SORT_LABELS: Record<ProductSort, string> = {
  recent: "Plus récents",
  name: "Nom (A–Z)",
  "price-asc": "Prix croissant",
  "price-desc": "Prix décroissant",
};

export default async function ProduitsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    categoryId?: string;
    source?: string;
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
  const sourceFilter =
    params.source && RECORD_SOURCE_LABELS[params.source] ? (params.source as RecordSource) : undefined;
  const categoryFilter = categories.find((c) => c.id === params.categoryId)?.id;
  const sortFilter: ProductSort =
    params.sort === "name" || params.sort === "price-asc" || params.sort === "price-desc"
      ? params.sort
      : "recent";

  const { products, total, pageSize } = await listProducts({
    q: params.q,
    status: statusFilter,
    categoryId: categoryFilter,
    source: sourceFilter,
    sort: sortFilter,
    page,
  });

  const hasActiveFilter = Boolean(
    params.q || statusFilter || sourceFilter || categoryFilter || params.sort
  );
  const paginationParams = {
    q: params.q,
    status: statusFilter,
    categoryId: categoryFilter,
    source: sourceFilter,
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

      <form className="mb-4 flex flex-wrap gap-2" action="/produits">
        <Input name="q" placeholder="Nom ou SKU..." defaultValue={params.q} className="max-w-56" />
        <Select name="status" defaultValue={params.status || "all"}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Statut">
              {statusFilter ? PRODUCT_STATUS_LABELS[statusFilter].label : "Tous les statuts"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            {Object.entries(PRODUCT_STATUS_LABELS).map(([value, meta]) => (
              <SelectItem key={value} value={value}>
                {meta.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="categoryId" defaultValue={categoryFilter ?? "all"}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Catégorie">
              {categoryFilter
                ? (categories.find((c) => c.id === categoryFilter)?.name ?? "Catégorie")
                : "Toutes catégories"}
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
        <Select name="source" defaultValue={params.source || "all"}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Origine">
              {sourceFilter ? RECORD_SOURCE_LABELS[sourceFilter] : "Toutes origines"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes origines</SelectItem>
            {Object.entries(RECORD_SOURCE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="sort" defaultValue={sortFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Trier">{SORT_LABELS[sortFilter]}</SelectValue>
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
          <Button variant="ghost" render={<Link href="/produits" />}>
            Réinitialiser
          </Button>
        ) : null}
      </form>

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
                const stock = p.trackInventory
                  ? p.inventoryItems.reduce((sum, i) => sum + i.quantityOnHand, 0)
                  : null;
                const isLow = stock !== null && stock <= p.lowStockThreshold;
                return (
                  <ClickableTableRow key={p.id} href={`/produits/${p.id}`}>
                    <TableCell className="font-medium">
                      {p.name}
                      {p.variations.length > 0 && (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          ({p.variations.length} variations)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.sku}</TableCell>
                    <TableCell className="text-muted-foreground">{p.category?.name ?? "—"}</TableCell>
                    <TableCell>{formatCurrency(p.price.toString())}</TableCell>
                    <TableCell>
                      {stock === null ? (
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
