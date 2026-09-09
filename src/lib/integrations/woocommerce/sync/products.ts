import "server-only";

import { prisma } from "@/lib/prisma";
import type { WooCommerceClient } from "../client";
import { mapProductFields } from "../mapper";
import type { WcProduct, WcProductVariation } from "../types";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";
import { reconcileStockFromWooCommerce } from "./stock";
import type { SyncActor } from "./actor";

/**
 * WooCommerce → System, one direction (see docs/adr/0010-woocommerce-integration.md).
 * Products are matched by (source=WOOCOMMERCE, externalId). Field
 * ownership: name/sku/description/price/salePrice/status/trackInventory/
 * categoryId are WooCommerce-owned and overwritten every sync; `cost` and
 * `lowStockThreshold` are internal-only and never touched here, even on an
 * update. A product with no matching internal Category (or no category at
 * all) is imported with `categoryId: null` — this is not an error.
 *
 * WooCommerce lets a product belong to several categories; the internal
 * schema has a single `categoryId` FK, so only the first WooCommerce
 * category (if any) is used — a deliberate, documented simplification, not
 * a silent data loss (the rest are simply not representable in this phase).
 *
 * Resumable and capped per run, for the same reason as `syncOrders` (see
 * its own doc comment): Vercel Hobby's tight wall-clock budget can't
 * guarantee a full catalog pass finishes in one call, and a variable
 * product costs an *extra* paginated request for its variations on top of
 * the product itself. Without a persisted resume point, a run that times
 * out mid-catalog restarted from page 1 every single time — so a product
 * sitting past wherever the scan always dies (a newly added one is
 * usually on the last page) could never be reached no matter how many
 * times "Synchroniser les produits" was clicked.
 *
 * Unlike `syncOrders`, an "already synced" product can't be skipped for
 * free on a resumed run: its stock still needs re-checking every single
 * pass (that's the whole point of the pull half of the stock sync — see
 * `reconcileStockFromWooCommerce` below), even when its name/price/etc.
 * haven't changed. So resuming at just "the same page number" would
 * reprocess that page's already-handled leading items until the cap,
 * making no forward progress ever on a page bigger than the cap. Instead,
 * `Integration.config.productsResumePage`/`productsResumeOffset` track
 * both the page AND the index within it this run stopped at, so the next
 * run picks up genuinely new/unchecked items on a re-fetch of that same
 * page instead of starting over from its first item.
 */
const MAX_PRODUCTS_PER_RUN = 20;

export async function syncProducts(
  client: WooCommerceClient,
  categoryIdMap: Map<number, string>,
  actor: SyncActor,
  integrationId: string
): Promise<SyncSummary> {
  const summary = emptySyncSummary();
  const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
  if (!warehouse) {
    // Without a default warehouse every `reconcileStockFromWooCommerce`
    // call below is skipped and stock silently never lands — surface that
    // instead of reporting a clean success. `provisionTenantBaseline`
    // creates this row for new tenants; `scripts/backfill-tenant-baseline.ts`
    // repairs older ones.
    recordNote(
      summary,
      "Aucun entrepôt par défaut configuré — les produits sont importés mais le stock ne peut pas être synchronisé. Contactez le support."
    );
  }

  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  const startPage =
    typeof config.productsResumePage === "number" && config.productsResumePage > 0
      ? Math.floor(config.productsResumePage)
      : 1;
  const startOffset =
    typeof config.productsResumeOffset === "number" && config.productsResumeOffset > 0
      ? Math.floor(config.productsResumeOffset)
      : 0;

  let processedThisRun = 0;
  let capped = false;
  let resumePage = 1;
  let resumeOffset = 0;
  let isFirstPageThisRun = true;

  for await (const { items: pageItems, page, totalPages } of client.listAllProducts(startPage)) {
    // The resume offset only applies to the very first page fetched this
    // run (wherever the previous run's cap actually stopped) — any later
    // page within the same run is fetched fresh and starts at its own 0.
    const applyOffset = isFirstPageThisRun && startOffset > 0;
    const items = applyOffset ? pageItems.slice(startOffset) : pageItems;
    let indexInPage = applyOffset ? startOffset : 0;
    isFirstPageThisRun = false;

    resumePage = page >= totalPages ? 1 : page + 1;
    resumeOffset = 0;

    for (const wc of items) {
      if (processedThisRun >= MAX_PRODUCTS_PER_RUN) {
        capped = true;
        resumePage = page;
        resumeOffset = indexInPage;
        break;
      }
      try {
        await syncOneProduct(client, wc, categoryIdMap, warehouse?.id ?? null, actor, summary);
      } catch {
        recordNote(summary, `Produit WooCommerce #${wc.id} (${wc.sku || wc.name}) : échec de synchronisation.`);
        summary.failed++;
      }
      processedThisRun++;
      indexInPage++;
    }
    if (capped) break;
  }

  await prisma.integration.update({
    where: { id: integrationId },
    data: { config: { ...config, productsResumePage: resumePage, productsResumeOffset: resumeOffset } },
  });

  summary.hasMore = capped;
  if (capped) {
    recordNote(
      summary,
      `Lot traité (max ${MAX_PRODUCTS_PER_RUN} produits) — relancez « Synchroniser les produits » pour continuer.`
    );
  }

  return summary;
}

async function syncOneProduct(
  client: WooCommerceClient,
  wc: WcProduct,
  categoryIdMap: Map<number, string> | null,
  warehouseId: string | null,
  actor: SyncActor,
  summary: SyncSummary
): Promise<void> {
  // A `product_variation` is NOT a catalogue product — it must only ever
  // become a `ProductVariation` row under its parent. WooCommerce's
  // `product.updated` webhook fires for variation saves too, and a
  // variation's REST body carries just enough (`name`, `slug:""`,
  // `status`) to slip past `wcProductSchema`. The webhook route already
  // redirects those to the parent, but this guard is the backstop so a
  // variation can never land as a standalone product no matter how
  // `syncOneProduct` is reached. See docs/adr/0010 addendum.
  if (wc.type === "variation") return;

  const fields = mapProductFields(wc);
  // The bulk sync passes a pre-built map (one query for the whole
  // catalog); a single-item webhook import has no map worth building for
  // one product, so it resolves the one category it needs directly.
  const categoryId = wc.categories[0]
    ? categoryIdMap
      ? (categoryIdMap.get(wc.categories[0].id) ?? null)
      : ((await prisma.category.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(wc.categories[0].id) } }))?.id ?? null)
    : null;
  const externalId = String(wc.id);

  const existing = await prisma.product.findFirst({ where: { source: "WOOCOMMERCE", externalId } });

  let productId: string;
  if (existing) {
    // Backfill / correct platformCreatedAt whenever WooCommerce gives us a
    // date the row doesn't already carry (rows imported before this field
    // existed have it set to their local createdAt by the migration).
    const needsPlatformDate =
      fields.platformCreatedAt !== null &&
      existing.platformCreatedAt?.getTime() !== fields.platformCreatedAt.getTime();

    const changed =
      existing.name !== fields.name ||
      existing.description !== fields.description ||
      Number(existing.price) !== fields.price ||
      (existing.salePrice ? Number(existing.salePrice) : null) !== fields.salePrice ||
      existing.status !== fields.status ||
      existing.trackInventory !== fields.trackInventory ||
      existing.categoryId !== categoryId ||
      needsPlatformDate;

    if (changed) {
      // A SKU collision against a *different* internal product (e.g. the
      // WooCommerce SKU was reused/renamed on the store side) must not
      // silently steal that other product's SKU — skip this field rather
      // than fail the whole item.
      const skuOwner = await prisma.product.findFirst({ where: { sku: fields.sku } });
      const sku = !skuOwner || skuOwner.id === existing.id ? fields.sku : existing.sku;

      await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: fields.name,
          sku,
          description: fields.description,
          price: fields.price,
          salePrice: fields.salePrice,
          status: fields.status,
          trackInventory: fields.trackInventory,
          categoryId,
          ...(fields.platformCreatedAt ? { platformCreatedAt: fields.platformCreatedAt } : {}),
        },
      });
      summary.updated++;
    } else {
      summary.unchanged++;
    }
    productId = existing.id;
  } else {
    const skuOwner = await prisma.product.findFirst({ where: { sku: fields.sku } });
    const sku = skuOwner ? `${fields.sku}-wc-${wc.id}` : fields.sku;

    const created = await prisma.product.create({
      data: {
        name: fields.name,
        sku,
        description: fields.description,
        price: fields.price,
        salePrice: fields.salePrice,
        status: fields.status,
        trackInventory: fields.trackInventory,
        categoryId,
        source: "WOOCOMMERCE",
        externalId,
        platformCreatedAt: fields.platformCreatedAt,
      },
    });
    productId = created.id;
    summary.imported++;
  }

  if (fields.trackInventory && wc.stock_quantity != null && warehouseId) {
    await reconcileStockFromWooCommerce({
      productId,
      warehouseId,
      externalQuantity: wc.stock_quantity,
      actor,
    });
  }

  if (wc.type === "variable" && wc.variations.length > 0) {
    await syncVariationsForProduct(client, wc.id, productId, warehouseId, actor, summary);
  }
}

async function syncVariationsForProduct(
  client: WooCommerceClient,
  wcProductId: number,
  productId: string,
  warehouseId: string | null,
  actor: SyncActor,
  summary: SyncSummary
): Promise<void> {
  const variationExternalIds: string[] = [];
  for await (const page of client.listAllProductVariations(wcProductId)) {
    for (const wcVar of page) {
      variationExternalIds.push(String(wcVar.id));
      try {
        const outcome = await syncOneVariation(wcVar, productId, warehouseId, actor);
        summary[outcome]++;
      } catch {
        recordNote(summary, `Variation WooCommerce #${wcVar.id} : échec de synchronisation.`);
        summary.failed++;
      }
    }
  }

  // Self-heal: a past `product.updated` webhook for a variation save may
  // have created a bogus standalone Product row keyed by the variation's
  // own id (the pre-fix behaviour — see docs/adr/0010 addendum). Now that
  // the variation is correctly attached to its parent, drop that
  // duplicate — but only when it carries no order history (OrderItem is
  // onDelete:SetNull, so a sale keeps its snapshot regardless, but we
  // still don't want to silently detach one).
  await cleanupBogusVariationProducts(variationExternalIds, productId, summary);
}

/**
 * Deletes standalone `Product` rows (source WOOCOMMERCE) whose `externalId`
 * is actually one of `variationExternalIds` — i.e. rows that a
 * variation-save webhook wrongly created before the parent-redirect fix.
 * A row with sold lines is left in place and reported instead.
 */
async function cleanupBogusVariationProducts(
  variationExternalIds: string[],
  realParentProductId: string,
  summary: SyncSummary
): Promise<void> {
  if (variationExternalIds.length === 0) return;
  const bogus = await prisma.product.findMany({
    where: {
      source: "WOOCOMMERCE",
      externalId: { in: variationExternalIds },
      id: { not: realParentProductId },
    },
    select: { id: true, name: true, _count: { select: { orderItems: true, variations: true } } },
  });
  for (const p of bogus) {
    // A genuine parent product would have its own variations; a bogus
    // variation-row never does. Guard against an id coincidence.
    if (p._count.variations > 0) continue;
    if (p._count.orderItems > 0) {
      recordNote(
        summary,
        `Produit en double « ${p.name} » (créé à tort depuis une variante) — conservé car il a un historique de commandes. À fusionner manuellement.`
      );
      continue;
    }
    await prisma.product.delete({ where: { id: p.id } });
    recordNote(summary, `Produit en double « ${p.name} » (issu d'une variante) supprimé.`);
  }
}

async function syncOneVariation(
  wc: WcProductVariation,
  productId: string,
  warehouseId: string | null,
  actor: SyncActor
): Promise<"imported" | "updated" | "unchanged"> {
  const externalId = String(wc.id);
  const sku = wc.sku.trim() || `WC-VAR-${wc.id}`;
  const price = wc.regular_price || wc.price || null;
  const attributes = Object.fromEntries(wc.attributes.map((a) => [a.name, a.option]));

  const existing = await prisma.productVariation.findFirst({ where: { source: "WOOCOMMERCE", externalId } });

  let variationId: string;
  let outcome: "imported" | "updated" | "unchanged" = "imported";
  if (existing) {
    const attrsChanged = JSON.stringify(existing.attributes) !== JSON.stringify(attributes);
    const priceChanged = price != null && Number(existing.price ?? 0) !== price;
    if (attrsChanged || priceChanged) {
      await prisma.productVariation.update({
        where: { id: existing.id },
        data: { attributes, price: price ?? existing.price },
      });
      outcome = "updated";
    } else {
      outcome = "unchanged";
    }
    variationId = existing.id;
  } else {
    const skuOwner = await prisma.productVariation.findFirst({ where: { sku } });
    const finalSku = skuOwner ? `${sku}-wc-${wc.id}` : sku;
    const created = await prisma.productVariation.create({
      data: {
        productId,
        sku: finalSku,
        attributes,
        price,
        source: "WOOCOMMERCE",
        externalId,
      },
    });
    variationId = created.id;
  }

  if (wc.manage_stock && wc.stock_quantity != null && warehouseId) {
    await reconcileStockFromWooCommerce({
      variationId,
      warehouseId,
      externalQuantity: wc.stock_quantity,
      actor,
    });
  }

  return outcome;
}

/**
 * Single-product counterpart to `syncProducts`, for the product.created/
 * product.updated webhook path (see docs/adr/0010-woocommerce-integration.md
 * addendum): imports/updates and reconciles stock for exactly one product
 * (and its variations, if any) — the same `syncOneProduct` the bulk sync
 * uses, just without a pre-built category map (see its own doc comment)
 * and resolving the default warehouse itself. Real-time product/stock
 * sync layered on top of the resumable bulk sync as a safety net for a
 * missed or never-configured webhook, not a replacement for it.
 */
export async function importProduct(
  client: WooCommerceClient,
  wc: WcProduct,
  actor: SyncActor
): Promise<{ outcome: "imported" | "updated" | "unchanged" | "failed" }> {
  const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
  const summary = emptySyncSummary();
  try {
    await syncOneProduct(client, wc, null, warehouse?.id ?? null, actor, summary);
  } catch {
    return { outcome: "failed" };
  }
  if (summary.imported > 0) return { outcome: "imported" };
  if (summary.updated > 0) return { outcome: "updated" };
  if (summary.failed > 0) return { outcome: "failed" };
  return { outcome: "unchanged" };
}
