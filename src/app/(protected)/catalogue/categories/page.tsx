import { Tag } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { FilterSearchInput } from "@/components/filter-search-input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CategoryFormDialog } from "@/components/products/category-form-dialog";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listCategoriesWithStats } from "@/lib/queries/products";
import { RECORD_SOURCE_LABELS } from "@/lib/status-labels";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Catégories — ASODITECH Gestion E-commerce" };

/**
 * Dedicated category management (Batch 3, Task 1) — list/search/create/edit
 * on top of the existing Category model and its existing actions
 * (createCategoryAction / the new updateCategoryAction in src/actions/
 * products.ts). No new business rule: a category synced from WooCommerce/
 * Shopify stays read-only here exactly like a synced product's definition
 * (docs/adr/0017/0038) — its edit control is simply not rendered.
 */
export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requirePermission("products.view");
  const params = await searchParams;
  const q = params.q?.trim().toLowerCase();

  const categories = await listCategoriesWithStats();
  const filtered = q
    ? categories.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q))
    : categories;

  const canCreate = userHasPermission(user, "products.create");
  const canEdit = userHasPermission(user, "products.edit");
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));

  return (
    <div>
      <PageHeader
        title="Catégories"
        breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: "Catégories" }]}
        description="Organisation du catalogue — une catégorie par produit, utilisée pour le filtrage et les rapports."
        actions={canCreate ? <CategoryFormDialog categoryOptions={categoryOptions} /> : undefined}
      />

      <div className="mb-4">
        <FilterSearchInput placeholder="Nom ou slug…" defaultValue={params.q} className="w-64" />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Tag}
          title={q ? "Aucune catégorie ne correspond." : "Aucune catégorie pour le moment."}
          description={!q && canCreate ? "Créez votre première catégorie pour organiser le catalogue." : undefined}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Parente</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Produits</TableHead>
                <TableHead className="text-right">Variantes</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead>Créée le</TableHead>
                {canEdit && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.name}
                    <div className="font-mono text-xs text-muted-foreground">{c.slug}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{c.parentName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={c.source === "INTERNE" ? "outline" : "secondary"}>
                      {RECORD_SOURCE_LABELS[c.source] ?? c.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.productCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.variantCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.stockOnHand}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                  {canEdit && (
                    <TableCell>
                      {c.source === "INTERNE" && (
                        <CategoryFormDialog
                          category={{ id: c.id, name: c.name, slug: c.slug, description: c.description, parentId: c.parentId }}
                          categoryOptions={categoryOptions.filter((o) => o.id !== c.id)}
                        />
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
