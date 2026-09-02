import { notFound } from "next/navigation";
import { Boxes, Tag, ShoppingBag, Wallet, Hash, FolderOpen, Receipt, FileText, Check, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { ProductForm } from "@/components/products/product-form";
import { VariationForm } from "@/components/products/variation-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getProductDetail, getProductSalesStats, listCategories } from "@/lib/queries/products";
import { formatCurrency } from "@/lib/format";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

/** One labeled fact in the spec strip (SKU / Catégorie / Coût d'achat) — icon, label, value. */
function SpecItem({
  icon: Icon,
  label,
  value,
  muted,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0 sm:border-l sm:border-border/70 sm:px-5 sm:py-0 sm:first:border-l-0 sm:first:pl-0">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("truncate text-sm font-medium", muted && "text-muted-foreground font-normal italic")}>
          {value}
        </p>
      </div>
    </div>
  );
}

/**
 * Renders a plain-text product description (HTML already stripped at
 * import time — see src/lib/integrations/shared/html.ts) as real
 * paragraphs/bullet lists instead of one undifferentiated block. Blocks
 * are separated by blank lines; a block whose every line starts with the
 * "• " marker (added by stripHtml for a WooCommerce/Shopify <li>) renders
 * as an actual bulleted list.
 */
/** A genuine "✓" bullet is a short phrase — a handful of words. */
const MAX_CHECKMARK_ITEM_LENGTH = 90;

/**
 * Recovers list structure from a block that was flattened before
 * paragraph-preserving stripHtml existed (an already-imported product
 * re-cleaned by hand, not a fresh sync) but still carries the source
 * HTML's literal "✓" bullet markers inline. Only real, present-in-the-
 * data delimiters are used — never a guessed sentence boundary. Since the
 * list's own end was never marked in the flattened text either, whatever
 * followed the last real bullet (unrelated trailing sections — a "why
 * customers love this" box, feature grid, etc.) would otherwise get
 * swept into one giant final "bullet"; the first oversized segment is
 * instead treated as where the list ends and ordinary trailing prose
 * resumes, not silently dropped.
 */
function splitOnCheckmarks(block: string): { intro: string | null; items: string[]; rest: string | null } | null {
  const segments = block.split("✓").map((s) => s.trim());
  if (segments.length < 3) return null;

  const items: string[] = [];
  const restParts: string[] = [];
  for (const seg of segments.slice(1)) {
    if (!seg) continue;
    if (restParts.length === 0 && seg.length <= MAX_CHECKMARK_ITEM_LENGTH) {
      items.push(seg);
    } else {
      restParts.push(seg);
    }
  }
  if (items.length < 2) return null;
  return { intro: segments[0] || null, items, rest: restParts.join(" ") || null };
}

function DescriptionBlocks({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim());
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const isList = lines.length > 0 && lines.every((l) => l.trim().startsWith("• "));
        if (isList) {
          return (
            <ul key={i} className="grid gap-2 sm:grid-cols-2">
              {lines.map((line, j) => (
                <li key={j} className="flex items-start gap-2 text-[14.5px] leading-relaxed text-foreground/90">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                  {line.replace(/^•\s*/, "")}
                </li>
              ))}
            </ul>
          );
        }

        const checkmarks = splitOnCheckmarks(block);
        if (checkmarks) {
          return (
            <div key={i} className="space-y-3">
              {checkmarks.intro && (
                <p className={cn("text-[14.5px] leading-relaxed text-foreground/90", i === 0 && "text-[15px] font-medium text-foreground")}>
                  {checkmarks.intro}
                </p>
              )}
              <ul className="grid gap-2.5 sm:grid-cols-2">
                {checkmarks.items.map((item, j) => (
                  <li key={j} className="flex items-start gap-2.5 rounded-lg bg-muted/50 px-3 py-2 text-[14px] leading-snug text-foreground/90">
                    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
              {checkmarks.rest && (
                <p className="text-[14.5px] leading-relaxed text-foreground/90">{checkmarks.rest}</p>
              )}
            </div>
          );
        }

        return (
          <p
            key={i}
            className={cn(
              "text-[14.5px] leading-relaxed whitespace-pre-line text-foreground/90",
              i === 0 && "text-[15px] font-medium text-foreground"
            )}
          >
            {block}
          </p>
        );
      })}
    </div>
  );
}

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
        <KpiCard label="Prix de vente" value={formatCurrency(product.price.toString())} icon={Tag} tone="primary" />
        <KpiCard
          label="Stock disponible"
          value={product.trackInventory ? String(totalStock) : null}
          unavailableReason="Non suivi"
          hint={isLowStock ? "Stock faible" : undefined}
          icon={Boxes}
          tone={isLowStock ? "danger" : "info"}
        />
        <KpiCard label="Unités vendues" value={String(sales.unitsSold)} icon={ShoppingBag} tone="violet" />
        <KpiCard
          label="Chiffre d'affaires généré"
          value={sales.revenue ? formatCurrency(sales.revenue.toString()) : "0,00 MAD"}
          icon={Wallet}
          tone="success"
        />
      </div>

      <Tabs defaultValue="apercu">
        <TabsList>
          <TabsTrigger value="apercu">Aperçu</TabsTrigger>
          <TabsTrigger value="variations">Variations</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          {canEdit && <TabsTrigger value="modifier">Modifier</TabsTrigger>}
        </TabsList>

        <TabsContent value="apercu" className="space-y-4">
          <Card>
            <CardContent className="flex flex-col sm:flex-row sm:items-center">
              <SpecItem icon={Hash} label="SKU" value={product.sku} />
              <SpecItem icon={FolderOpen} label="Catégorie" value={product.category?.name ?? "Aucune"} muted={!product.category} />
              <SpecItem
                icon={Receipt}
                label="Coût d'achat"
                value={product.cost ? formatCurrency(product.cost.toString()) : "Non renseigné"}
                muted={!product.cost}
              />
            </CardContent>
          </Card>

          {product.description && (
            <Card>
              <CardHeader className="flex-row items-center gap-2.5 space-y-0">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText className="size-4" />
                </div>
                <CardTitle>Description</CardTitle>
              </CardHeader>
              <CardContent>
                <DescriptionBlocks text={product.description} />
              </CardContent>
            </Card>
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
