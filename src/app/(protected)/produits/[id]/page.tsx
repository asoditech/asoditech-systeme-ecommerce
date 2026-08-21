import { notFound } from "next/navigation";
import { Boxes } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { ProductForm } from "@/components/products/product-form";
import { VariationForm } from "@/components/products/variation-form";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getProductDetail, getProductSalesStats, listCategories } from "@/lib/queries/products";
import { formatCurrency } from "@/lib/format";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";

export default async function ProduitDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("products.view");
  const { id } = await params;
  const [product, categories] = await Promise.all([getProductDetail(id), listCategories()]);
  if (!product) notFound();

  const sales = await getProductSalesStats(id);
  const canEdit = hasPermission(user.role, "products.edit");
  const totalStock = product.inventoryItems.reduce((sum, i) => sum + i.quantityOnHand, 0);
  const isLowStock = product.trackInventory && totalStock <= product.lowStockThreshold;

  return (
    <div>
      <PageHeader
        title={product.name}
        breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: product.name }]}
        actions={<StatusBadge status={product.status} labels={PRODUCT_STATUS_LABELS} />}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Prix de vente" value={formatCurrency(product.price.toString())} />
        <KpiCard
          label="Stock disponible"
          value={product.trackInventory ? String(totalStock) : null}
          unavailableReason="Non suivi"
          hint={isLowStock ? "Stock faible" : undefined}
        />
        <KpiCard label="Unités vendues" value={String(sales.unitsSold)} />
        <KpiCard
          label="Chiffre d'affaires généré"
          value={sales.revenue ? formatCurrency(sales.revenue.toString()) : "0,00 MAD"}
        />
      </div>

      <Tabs defaultValue="apercu">
        <TabsList>
          <TabsTrigger value="apercu">Aperçu</TabsTrigger>
          <TabsTrigger value="variations">Variations</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          {canEdit && <TabsTrigger value="modifier">Modifier</TabsTrigger>}
        </TabsList>

        <TabsContent value="apercu" className="space-y-2 text-sm">
          <p>
            <span className="text-muted-foreground">SKU : </span>
            {product.sku}
          </p>
          <p>
            <span className="text-muted-foreground">Catégorie : </span>
            {product.category?.name ?? "Aucune"}
          </p>
          <p>
            <span className="text-muted-foreground">Coût d&apos;achat : </span>
            {product.cost ? formatCurrency(product.cost.toString()) : "Non renseigné"}
          </p>
          {product.description && (
            <p className="whitespace-pre-wrap text-muted-foreground">{product.description}</p>
          )}
        </TabsContent>

        <TabsContent value="variations" className="space-y-4">
          {product.variations.length === 0 ? (
            <EmptyState icon={Boxes} title="Aucune variation pour ce produit." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Attributs</TableHead>
                    <TableHead>Prix</TableHead>
                    <TableHead>Stock</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.variations.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">{v.sku}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(v.attributes as Record<string, string>).map(([k, val]) => (
                            <Badge key={k} variant="outline">
                              {k}: {val}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>{formatCurrency((v.price ?? product.price).toString())}</TableCell>
                      <TableCell>{v.inventoryItems.reduce((sum, i) => sum + i.quantityOnHand, 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {canEdit && <VariationForm productId={product.id} />}
        </TabsContent>

        <TabsContent value="stock">
          {!product.trackInventory ? (
            <EmptyState icon={Boxes} title="Le suivi de stock est désactivé pour ce produit." />
          ) : product.inventoryItems.length === 0 ? (
            <EmptyState icon={Boxes} title="Aucun enregistrement de stock." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Entrepôt</TableHead>
                    <TableHead>Disponible</TableHead>
                    <TableHead>Réservé</TableHead>
                    <TableHead>Endommagé</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.inventoryItems.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.warehouse.name}</TableCell>
                      <TableCell>{i.quantityOnHand}</TableCell>
                      <TableCell>{i.quantityReserved}</TableCell>
                      <TableCell>{i.quantityDamaged}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {canEdit && (
          <TabsContent value="modifier">
            <div className="max-w-2xl">
              <ProductForm
                product={{
                  ...product,
                  price: product.price.toString(),
                  salePrice: product.salePrice?.toString() ?? null,
                  cost: product.cost?.toString() ?? null,
                }}
                categories={categories}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
