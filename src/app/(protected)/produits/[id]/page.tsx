import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Boxes,
  Tag,
  ShoppingBag,
  Wallet,
  Hash,
  FolderOpen,
  Receipt,
  FileText,
  Check,
  Store,
  ExternalLink,
  AlertTriangle,
  LogIn,
  Percent,
  PiggyBank,
  Package,
  Info,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { ProductForm } from "@/components/products/product-form";
import { BackfillCostButton } from "@/components/products/backfill-cost-button";
import { RemoveProductButton } from "@/components/products/remove-product-button";
import { VariationCostCell } from "@/components/products/variation-cost-cell";
import { VariantCombinationGenerator } from "@/components/products/variant-combination-generator";
import { VariantEditDialog } from "@/components/products/variant-edit-dialog";
import { VariantRemoveButton } from "@/components/products/variant-remove-button";
import { VariationPurchaseHistoryDialog } from "@/components/products/variation-purchase-history-dialog";
import { OperationalSettingsForm } from "@/components/products/operational-settings-form";
import { ProductImageGallery } from "@/components/products/product-image-gallery";
import { ProductImagePreview } from "@/components/products/product-image-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getProductDetail, getProductSalesStats, getProductProfitStats, listCategories } from "@/lib/queries/products";
import { getLatestPurchasePricesForUnits, getPurchasePriceHistory, type PurchasePriceHistoryEntry } from "@/lib/queries/purchases";
import { listActiveChannels } from "@/lib/queries/channels";
import { ProductIdentityPanel } from "@/components/products/product-identity-panel";
import { ProductPublishPanel, type PublishChannel } from "@/components/products/product-publish-panel";
import { variantLabel } from "@/lib/catalog/lookup";
import { unitEconomics } from "@/lib/profitability";
import { availableStock } from "@/lib/inventory";
import { prisma } from "@/lib/prisma";
import { resolveExternalProductEditUrl, resolveExternalAdminUrl } from "@/lib/integrations/shared";
import { isShopifyIntegrationEnabled } from "@/lib/integrations/shopify/feature-flag";
import { formatCurrency, formatDate, displayReceptionNumber } from "@/lib/format";
import { PRODUCT_STATUS_LABELS, RECORD_SOURCE_LABELS } from "@/lib/status-labels";
import { cn } from "@/lib/utils";
import type { RecordSource } from "@prisma/client";

const SOURCE_ICON: Partial<Record<RecordSource, LucideIcon>> = {
  WOOCOMMERCE: Store,
  SHOPIFY: ShoppingBag,
};

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

export default async function ProduitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `tab` opens a specific tab on load (used by the create-product flow's
   * "Ce produit possède des variantes" redirect, Batch 9, Group 3);
   * `variants=1` additionally auto-opens the combination generator instead
   * of just showing its trigger button, so create → define-variants reads
   * as one continuous flow.
   */
  searchParams: Promise<{ tab?: string; variants?: string }>;
}) {
  const user = await requirePermission("products.view");
  const { id } = await params;
  const { tab, variants } = await searchParams;
  const defaultTab = tab === "variations" || tab === "stock" || tab === "identite" || tab === "modifier" ? tab : "apercu";
  // Business-mode capabilities (docs/adr/0041): the Identité tab (reference,
  // barcodes, channel availability) exists only in an ONLINE_AND_OFFLINE tenant.
  const identityEnabled = user.capabilities.has("catalogIdentity");
  const [product, categories, channels] = await Promise.all([
    getProductDetail(id),
    listCategories(),
    identityEnabled ? listActiveChannels() : Promise.resolve([]),
  ]);
  if (!product) notFound();

  // Sales / profit figures are aggregated from delivery ORDERS — Online data
  // (docs/adr/0039). Without an ONLINE channel they are neither computed nor
  // shown; the Offline counterpart is read from sales (docs/adr/0040).
  const seesOnlineStats = user.channels.online;
  const canViewFinance = userHasPermission(user, "finance.view") && seesOnlineStats;
  const [sales, profit] = await Promise.all([
    seesOnlineStats ? getProductSalesStats(id) : Promise.resolve({ unitsSold: 0, revenue: null }),
    canViewFinance ? getProductProfitStats(id) : Promise.resolve(null),
  ]);
  const economics = canViewFinance ? unitEconomics(product.price, product.cost) : null;
  const canEdit = userHasPermission(user, "products.edit");
  const totalStock = product.inventoryItems.reduce((sum, i) => sum + i.quantityOnHand, 0);

  // Batch 13 (Product Publishing) — connected external channels this
  // product could be published to, and its existing publication state on
  // each. Independent of `identityEnabled`/business mode: publishing is an
  // online-integration concern for every tenant, not the offline-store
  // capability set. Only a real, verified CONNECTE integration is ever
  // offered as a target (Section 4) — a disconnected one simply isn't
  // listed, never a disabled "fake" button. Respects the same Shopify kill
  // switch (client feedback #10) every other Shopify entry point does.
  const canPublish = canEdit && userHasPermission(user, "integrations.manage");
  const publishProviders: ("WOOCOMMERCE" | "SHOPIFY")[] = isShopifyIntegrationEnabled()
    ? ["WOOCOMMERCE", "SHOPIFY"]
    : ["WOOCOMMERCE"];
  const connectedIntegrations = canEdit
    ? await prisma.integration.findMany({ where: { provider: { in: publishProviders }, status: "CONNECTE" } })
    : [];
  const publishChannels: PublishChannel[] = await Promise.all(
    connectedIntegrations.map(async (integration) => {
      const provider = integration.provider as "WOOCOMMERCE" | "SHOPIFY";
      const existingPublication = product.publications.find((p) => p.provider === provider);
      return {
        provider,
        label: provider === "WOOCOMMERCE" ? "WooCommerce" : "Shopify",
        published: existingPublication
          ? {
              externalId: existingPublication.externalId,
              adminUrl: await resolveExternalAdminUrl(provider, existingPublication.externalId),
            }
          : null,
      };
    })
  );

  // "Dernier prix d'achat" / purchase-price history (Batch 3, Task 3B) — read
  // straight off the existing Reception/ReceptionLine data, gated by the
  // purchases permission (this is supplier/purchase data, independent of
  // finance.view). A variable product's price lives per variation, so the
  // history list only applies to a simple product; each variation instead
  // gets its own "Dernier achat" figure in the variations table below.
  const canViewPurchases = userHasPermission(user, "purchases.view");
  const isSimpleProduct = product.variations.length === 0;
  const [latestPurchasePrices, purchaseHistory] = await Promise.all([
    canViewPurchases
      ? getLatestPurchasePricesForUnits(isSimpleProduct ? [product.id] : [], product.variations.map((v) => v.id))
      : Promise.resolve(new Map<string, PurchasePriceHistoryEntry>()),
    canViewPurchases && isSimpleProduct ? getPurchasePriceHistory({ productId: product.id }, 10) : Promise.resolve([] as PurchasePriceHistoryEntry[]),
  ]);
  const latestPurchasePrice = isSimpleProduct ? latestPurchasePrices.get(product.id) : undefined;

  // A variable product keeps no price or stock of its own (WooCommerce
  // puts both on the variations) — surface the aggregate so the header
  // isn't a misleading "0,00 MAD / Non suivi".
  const isVariable = product.variations.length > 0;
  const variationPrices = product.variations
    .map((v) => (v.price != null ? Number(v.price) : null))
    .filter((n): n is number => n != null && n > 0);
  const displayPriceLabel = isVariable
    ? variationPrices.length > 0
      ? (() => {
          const lo = Math.min(...variationPrices);
          const hi = Math.max(...variationPrices);
          return lo === hi ? formatCurrency(String(lo)) : `${formatCurrency(String(lo))} – ${formatCurrency(String(hi))}`;
        })()
      : "—"
    : formatCurrency(product.price.toString());
  const variationStock = product.variations.reduce(
    (sum, v) => sum + v.inventoryItems.reduce((n, i) => n + i.quantityOnHand, 0),
    0
  );
  const variationStockTracked = product.variations.some((v) => v.inventoryItems.length > 0);
  const displayStock = isVariable
    ? variationStockTracked
      ? variationStock
      : null
    : product.trackInventory
      ? totalStock
      : null;
  const isLowStock = displayStock !== null && displayStock <= product.lowStockThreshold;

  // Product *definition* (name/sku/price/description/status/category) is
  // owned by WooCommerce/Shopify once a product is externally sourced —
  // ASODITECH is not a second product editor. See
  // docs/adr/0017-product-management-boundary.md.
  const isExternal = product.source !== "INTERNE";
  const externalEditUrl = isExternal ? await resolveExternalProductEditUrl(product) : null;
  const externalLabel = product.source === "WOOCOMMERCE" ? "WooCommerce" : product.source === "SHOPIFY" ? "Shopify" : null;

  return (
    <div>
      <PageHeader
        title={product.name}
        breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: product.name }]}
        actions={
          <>
            <StatusBadge status={product.status} labels={PRODUCT_STATUS_LABELS} />
            {isExternal && canEdit && externalEditUrl && externalLabel && (
              <Button
                render={
                  <a
                    href={externalEditUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Ouvre l'administration ${externalLabel} — connectez-vous d'abord si nécessaire.`}
                  />
                }
              >
                Modifier sur {externalLabel}
                <ExternalLink className="size-4" />
              </Button>
            )}
            {canEdit && (
              <RemoveProductButton
                productId={product.id}
                productName={product.name}
                neverSold={product._count.orderItems === 0}
              />
            )}
          </>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={isVariable ? "Prix de vente (fourchette)" : "Prix de vente"}
          value={displayPriceLabel}
          icon={Tag}
          tone="primary"
        />
        <KpiCard
          label="Stock disponible"
          value={displayStock !== null ? String(displayStock) : null}
          unavailableReason="Non suivi"
          hint={isLowStock ? "Stock faible" : isVariable ? "Cumul des variations" : undefined}
          icon={Boxes}
          tone={isLowStock ? "danger" : "info"}
        />
        {seesOnlineStats && (
          <>
            <KpiCard label="Unités vendues" value={String(sales.unitsSold)} icon={ShoppingBag} tone="violet" />
            <KpiCard
              label="Chiffre d'affaires généré"
              value={sales.revenue ? formatCurrency(sales.revenue.toString()) : "0,00 MAD"}
              icon={Wallet}
              tone="success"
            />
          </>
        )}
      </div>

      {canViewFinance && profit && economics && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-[15px]">Rentabilité</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-3">
              <KpiCard
                label="Marge unitaire"
                value={
                  economics.unitMargin === null
                    ? null
                    : `${formatCurrency(String(economics.unitMargin))}${
                        economics.unitMarginPct !== null ? ` · ${economics.unitMarginPct.toFixed(1)} %` : ""
                      }`
                }
                unavailableReason="Coût d'achat non renseigné"
                hint={
                  economics.unitCost !== null
                    ? `Prix ${formatCurrency(product.price.toString())} − coût ${formatCurrency(String(economics.unitCost))}`
                    : undefined
                }
                icon={Percent}
                tone={economics.unitMargin === null ? "warning" : "info"}
              />
              <KpiCard
                label="Bénéfice brut réalisé"
                value={profit.grossProfit === null ? null : formatCurrency(String(profit.grossProfit))}
                unavailableReason="Coût manquant sur des ventes"
                hint={`CA ${formatCurrency(String(profit.revenue))}${
                  profit.cogs !== null ? ` − coût ${formatCurrency(String(profit.cogs))}` : ""
                }`}
                trend={
                  profit.grossProfit !== null && profit.marginPct !== null
                    ? { direction: "flat", label: `${profit.marginPct.toFixed(1)} %` }
                    : undefined
                }
                icon={PiggyBank}
                tone={profit.grossProfit === null ? "warning" : "success"}
              />
              <KpiCard label="Unités vendues (net des retours)" value={String(profit.unitsSold)} icon={Package} tone="violet" />
            </div>
            <div className="mt-4 flex gap-2 rounded-lg bg-muted/40 p-3">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Le bénéfice réalisé utilise le coût figé <strong>au moment de chaque vente</strong>. Une vente enregistrée
                  avant que vous ne renseigniez le coût d&apos;achat n&apos;a pas de coût figé — c&apos;est pourquoi le
                  bénéfice peut rester « coût manquant » même après avoir saisi le coût aujourd&apos;hui.
                </p>
                {canEdit && !profit.cogsComplete && profit.linesMissingCost > 0 && product.cost !== null && (
                  <BackfillCostButton productId={product.id} missingCount={profit.linesMissingCost} />
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="apercu">Aperçu</TabsTrigger>
          <TabsTrigger value="variations">Variations</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
          {identityEnabled && <TabsTrigger value="identite">Identité</TabsTrigger>}
          {canEdit && <TabsTrigger value="modifier">Modifier</TabsTrigger>}
        </TabsList>

        <TabsContent value="apercu" className="space-y-4">
          <Card>
            <CardContent className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center">
              <SpecItem
                icon={SOURCE_ICON[product.source] ?? Hash}
                label="Source"
                value={
                  product.externalId
                    ? `${RECORD_SOURCE_LABELS[product.source]} (réf. ${product.externalId})`
                    : RECORD_SOURCE_LABELS[product.source]
                }
              />
              <SpecItem icon={Hash} label="SKU" value={product.sku} />
              {identityEnabled && product.reference && <SpecItem icon={Hash} label="Référence modèle" value={product.reference} />}
              <SpecItem icon={FolderOpen} label="Catégorie" value={product.category?.name ?? "Aucune"} muted={!product.category} />
              <SpecItem
                icon={Receipt}
                label="Coût d'achat"
                value={product.cost ? formatCurrency(product.cost.toString()) : "Non renseigné"}
                muted={!product.cost}
              />
              {canViewPurchases && isSimpleProduct && (
                <SpecItem
                  icon={Receipt}
                  label="Dernier prix d'achat"
                  value={
                    latestPurchasePrice
                      ? `${formatCurrency(String(latestPurchasePrice.unitCost))} — ${latestPurchasePrice.supplierName}`
                      : "Aucun achat enregistré"
                  }
                  muted={!latestPurchasePrice}
                />
              )}
            </CardContent>
          </Card>

          {canViewPurchases && isSimpleProduct && purchaseHistory.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-[15px]">Historique des achats</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <p className="px-6 pb-3 text-xs text-muted-foreground">
                  Prix constatés sur les réceptions validées — information historique, ne remplace pas le « Coût
                  d&apos;achat » ci-dessus (utilisé pour la marge).
                </p>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Fournisseur</TableHead>
                        <TableHead>Réception</TableHead>
                        <TableHead className="text-right">Prix unitaire</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {purchaseHistory.map((h, i) => (
                        <TableRow key={`${h.receptionId}-${i}`}>
                          <TableCell className="text-muted-foreground">{formatDate(h.date)}</TableCell>
                          <TableCell>{h.supplierName}</TableCell>
                          <TableCell>
                            <Link href={`/receptions/${h.receptionId}`} className="hover:underline">
                              {displayReceptionNumber({ receptionNumber: h.receptionNumber, displayNumber: h.receptionDisplayNumber })}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(String(h.unitCost))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {isExternal && !externalEditUrl && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <p>
                Le lien de gestion {externalLabel} n&apos;est pas disponible pour le moment (intégration
                déconnectée ou non configurée). Vérifiez la connexion dans{" "}
                <Link href="/integrations" className="font-medium underline underline-offset-2">
                  Intégrations
                </Link>
                .
              </p>
            </div>
          )}

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
            <>
              {canViewFinance && (
                <p className="text-xs text-muted-foreground">
                  Pour un produit à variantes, le prix et le stock vivent sur chaque variante — et le coût d&apos;achat se
                  saisit ici, par variante (le champ « coût » de l&apos;onglet Modifier ne s&apos;applique qu&apos;aux
                  produits simples).
                </p>
              )}
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Attributs</TableHead>
                      <TableHead>Code-barres</TableHead>
                      <TableHead className="text-right">Prix</TableHead>
                      {canViewFinance && (
                        <TableHead className="text-right whitespace-nowrap">Coût d&apos;achat</TableHead>
                      )}
                      {canViewPurchases && (
                        <TableHead className="text-right whitespace-nowrap">Dernier achat</TableHead>
                      )}
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead>Statut</TableHead>
                      {canEdit && !isExternal && <TableHead className="w-20" />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variations.map((v) => {
                      const label = `${product.name} (${variantLabel(v.attributes) ?? v.sku})`;
                      const effectivePrice = v.salePrice ?? v.price ?? product.price;
                      const regularPrice = v.price ?? product.price;
                      return (
                        <TableRow key={v.id}>
                          <TableCell className="font-medium">
                            <ProductImagePreview imageUrl={v.imageUrl} name={label}>
                              {v.sku}
                            </ProductImagePreview>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(v.attributes as Record<string, string>).map(([k, val]) => (
                                <Badge key={k} variant="outline">
                                  {k}: {val}
                                </Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {v.barcodes[0]?.code ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(effectivePrice.toString())}
                            {v.salePrice != null && (
                              <Badge variant="destructive" className="ml-1.5 align-middle">
                                Promo
                              </Badge>
                            )}
                          </TableCell>
                          {canViewFinance && (
                            <TableCell className="text-right whitespace-nowrap tabular-nums">
                              {canEdit ? (
                                // key forces a remount when the server value changes from elsewhere
                                // (e.g. VariantEditDialog also writes `cost`) — otherwise this cell's
                                // own local input state would keep showing what it had before a
                                // `router.refresh()`, same fix as ProductImageForm's `key={currentUrl}`.
                                <VariationCostCell key={v.cost?.toString() ?? ""} variationId={v.id} cost={v.cost?.toString() ?? null} />
                              ) : v.cost ? (
                                formatCurrency(v.cost.toString())
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          )}
                          {canViewPurchases && (
                            <TableCell className="text-right whitespace-nowrap text-xs">
                              <VariationPurchaseHistoryDialog
                                variationId={v.id}
                                label={label}
                                latestUnitCost={latestPurchasePrices.get(v.id)?.unitCost ?? null}
                              />
                            </TableCell>
                          )}
                          <TableCell className="text-right tabular-nums">
                            {v.inventoryItems.reduce((sum, i) => sum + i.quantityOnHand, 0)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={v.isActive ? "default" : "outline"}>{v.isActive ? "Actif" : "Inactif"}</Badge>
                          </TableCell>
                          {canEdit && !isExternal && (
                            <TableCell>
                              <div className="flex items-center justify-end gap-0.5">
                                <VariantEditDialog
                                  variation={{
                                    id: v.id,
                                    sku: v.sku,
                                    cost: v.cost?.toString() ?? null,
                                    salePrice: v.salePrice?.toString() ?? null,
                                    imageUrl: v.imageUrl,
                                    isActive: v.isActive,
                                  }}
                                  label={label}
                                  regularPrice={regularPrice.toString()}
                                />
                                <VariantRemoveButton variationId={v.id} label={label} />
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
          {/* Managing variations is catalog editing — for an externally-sourced
              product that belongs on the platform the product lives on, not a
              second editor here. See docs/adr/0017-product-management-boundary.md.
              Barcodes per variation are managed in the Identité tab, not here. */}
          {canEdit && !isExternal && (
            <VariantCombinationGenerator
              productId={product.id}
              existingAttributes={product.variations.map((v) => v.attributes as Record<string, string>)}
              defaultOpen={variants === "1" && product.variations.length === 0}
            />
          )}
          {canEdit && isExternal && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Les tailles/couleurs de ce produit viennent de{" "}
                {product.source === "WOOCOMMERCE" ? "WooCommerce" : "Shopify"} — ajoutez-en sur la plateforme
                d&apos;origine, pas depuis ASODITECH.
              </span>
            </p>
          )}
        </TabsContent>

        {identityEnabled && (
        <TabsContent value="identite">
          <ProductIdentityPanel
            productId={product.id}
            reference={product.reference}
            canEdit={canEdit}
            channels={channels.map((c) => ({ id: c.id, name: c.name, kind: c.kind }))}
            enabledChannelIds={product.salesChannels.map((c) => c.salesChannelId)}
            units={
              isVariable
                ? product.variations.map((v) => ({
                    variationId: v.id,
                    label: variantLabel(v.attributes) ?? v.sku,
                    sku: v.sku,
                    barcodes: v.barcodes.map((b) => ({ id: b.id, code: b.code, isPrimary: b.isPrimary })),
                  }))
                : [
                    {
                      variationId: null,
                      label: product.name,
                      sku: product.sku,
                      barcodes: product.barcodes.map((b) => ({ id: b.id, code: b.code, isPrimary: b.isPrimary })),
                    },
                  ]
            }
          />
        </TabsContent>
        )}

        <TabsContent value="stock">
          {isVariable ? (
            variationStockTracked ? (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Variante</TableHead>
                      <TableHead>Emplacement</TableHead>
                      <TableHead className="text-right">Stock physique</TableHead>
                      <TableHead className="text-right">Réservé</TableHead>
                      <TableHead className="text-right">Disponible</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variations.flatMap((v) =>
                      v.inventoryItems.length === 0
                        ? [
                            <TableRow key={v.id}>
                              <TableCell className="font-medium">{v.sku}</TableCell>
                              <TableCell colSpan={4} className="text-muted-foreground">
                                Aucun enregistrement de stock.
                              </TableCell>
                            </TableRow>,
                          ]
                        : v.inventoryItems.map((i) => (
                            <TableRow key={i.id}>
                              <TableCell className="font-medium">{v.sku}</TableCell>
                              <TableCell>{i.warehouse.name}</TableCell>
                              <TableCell className="text-right tabular-nums">{i.quantityOnHand}</TableCell>
                              <TableCell className="text-right tabular-nums">{i.quantityReserved}</TableCell>
                              <TableCell className="text-right tabular-nums">{availableStock(i)}</TableCell>
                            </TableRow>
                          ))
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState
                icon={Boxes}
                title="Stock des variantes pas encore synchronisé."
                description="Le stock d'un produit à variantes est suivi par variante. Relancez « Synchroniser les produits » dans Intégrations une fois la connexion rétablie."
              />
            )
          ) : !product.trackInventory ? (
            <EmptyState icon={Boxes} title="Le suivi de stock est désactivé pour ce produit." />
          ) : product.inventoryItems.length === 0 ? (
            <EmptyState icon={Boxes} title="Aucun enregistrement de stock." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Emplacement</TableHead>
                    <TableHead>Stock physique</TableHead>
                    <TableHead>Réservé</TableHead>
                    <TableHead>Disponible</TableHead>
                    <TableHead>Endommagé</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {product.inventoryItems.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.warehouse.name}</TableCell>
                      <TableCell>{i.quantityOnHand}</TableCell>
                      <TableCell>{i.quantityReserved}</TableCell>
                      <TableCell>{availableStock(i)}</TableCell>
                      <TableCell>{i.quantityDamaged}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {canEdit && (
          <TabsContent value="modifier" className="space-y-4">
            <div className="max-w-2xl space-y-4">
              {isExternal ? (
                <>
                  <Card>
                    <CardContent className="flex flex-col items-start gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-medium">Ce produit est géré sur {externalLabel}.</p>
                        <p className="text-sm text-muted-foreground">
                          Nom, SKU, prix, description, statut et catégorie sont gérés sur {externalLabel} — ASODITECH
                          les synchronise, sans les modifier.
                        </p>
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
                          <LogIn className="mt-0.5 size-3.5 shrink-0" />
                          <span>Ce lien ouvre l&apos;administration {externalLabel} — connectez-vous d&apos;abord si nécessaire.</span>
                        </p>
                      </div>
                      {externalEditUrl && (
                        <Button
                          render={<a href={externalEditUrl} target="_blank" rel="noopener noreferrer" />}
                          className="shrink-0"
                        >
                          Modifier sur {externalLabel}
                          <ExternalLink className="size-4" />
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                  <OperationalSettingsForm
                    productId={product.id}
                    cost={product.cost?.toString() ?? null}
                    trackInventory={product.trackInventory}
                    lowStockThreshold={product.lowStockThreshold}
                  />
                </>
              ) : (
                <>
                  <ProductImageGallery
                    productId={product.id}
                    images={product.images.map((img) => ({
                      id: img.id,
                      url: img.url,
                      altText: img.altText,
                      position: img.position,
                    }))}
                  />
                  <ProductForm
                    product={{
                      ...product,
                      price: product.price.toString(),
                      salePrice: product.salePrice?.toString() ?? null,
                      cost: product.cost?.toString() ?? null,
                    }}
                    categories={categories}
                  />
                </>
              )}
              <ProductPublishPanel
                productId={product.id}
                productName={product.name}
                channels={publishChannels}
                canPublish={canPublish}
              />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
