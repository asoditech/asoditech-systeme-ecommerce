import Link from "next/link";
import { Package, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listProducts } from "@/lib/queries/products";
import { formatCurrency } from "@/lib/format";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Produits — ASODITECH Gestion E-commerce" };

export default async function ProduitsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePermission("products.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const { products, total, pageSize } = await listProducts({ q: params.q, page });

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

      <form className="mb-4 flex gap-2" action="/produits">
        <Input name="q" placeholder="Rechercher par nom ou SKU..." defaultValue={params.q} className="max-w-sm" />
        <Button type="submit" variant="outline">
          Rechercher
        </Button>
      </form>

      {products.length === 0 ? (
        <EmptyState
          icon={Package}
          title={params.q ? "Aucun produit ne correspond à votre recherche." : "Aucun produit pour le moment."}
          description={!params.q ? "Ajoutez votre premier produit pour commencer à vendre." : undefined}
          action={
            !params.q && hasPermission(user.role, "products.create") ? (
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
            searchParams={{ q: params.q }}
          />
        </div>
      )}
    </div>
  );
}
