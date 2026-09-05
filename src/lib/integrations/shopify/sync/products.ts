import "server-only";

import { prisma } from "@/lib/prisma";
import type { ShopifyClient } from "../client";
import { mapSimpleProductFields, mapVariantFields, isSimpleProduct, mapProductStatus } from "../mapper";
import { availableFrom } from "../types";
import type { ShopifyProduct, ShopifyVariant } from "../types";
import { emptySyncSummary, recordNote, reconcileStockFromProvider, type SyncSummary, type SyncActor } from "@/lib/integrations/shared";

/**
 * Shopify → System, one direction (see docs/adr/0011-shopify-integration.md).
 * Products are matched by (source=SHOPIFY, externalId=<product gid>).
 * Field ownership mirrors the WooCommerce integration: name/sku/
 * description/price/status/trackInventory are Shopify-owned and
 * overwritten every sync; `cost` and `lowStockThreshold` are
 * internal-only and never touched here, even on an update.
 *
 * Shopify has no single-parent Category concept comparable to this
 * system's Category tree — Collections are many-to-many, and the newer
 * standardized product taxonomy is a separate, evolving concept. Neither
 * is mapped in this phase (categoryId stays null for Shopify-sourced
 * products) — a deliberate, documented decision, not silent data loss.
 * See the ADR's "deferred" section.
 *
 * Resumable and capped per run, for the same reason as `syncOrders` (see
 * its own doc comment): Vercel Hobby's tight wall-clock budget can't
 * guarantee a full catalog pass finishes in one call. Without a persisted
 * resume point, a run that times out mid-catalog restarted from the start
 * every single time — so a product sitting past wherever the scan always
 * dies (a newly added one is usually last) could never be reached no
 * matter how many times "Synchroniser les produits" was clicked.
 *
 * Unlike `syncOrders`, an "already synced" product can't be skipped for
 * free on a resumed run: its stock still needs re-checking every single
 * pass (that's the whole point of the pull half of the stock sync), even
 * when its name/price/etc. haven't changed. Shopify also has no
 * page-number pagination to resume "the next page" from — one GraphQL
 * page can hold up to 50 products in a single response, well above the
 * per-run cap. So resuming at just the page's cursor would re-fetch and
 * restart from that same page's *first* item every time, making no
 * forward progress past a page bigger than the cap.
 * `Integration.config.productsResumeCursor`/`productsResumeOffset` track
 * both the cursor AND the index within that refetched page this run
 * stopped at, so the next run skips straight to the genuinely
 * new/unchecked items in memory after re-fetching the same page.
 */
const MAX_PRODUCTS_PER_RUN = 20;

export async function syncProducts(
  client: ShopifyClient,
  locationIdMap: Map<string, string>,
  actor: SyncActor,
  integrationId: string
): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  const startCursor = typeof config.productsResumeCursor === "string" ? config.productsResumeCursor : null;
  const startOffset =
    typeof config.productsResumeOffset === "number" && config.productsResumeOffset > 0
      ? Math.floor(config.productsResumeOffset)
      : 0;

  let processedThisRun = 0;
  let capped = false;
  // The cursor `listAllProducts` was called with for whichever page is
  // currently being iterated — i.e. what re-fetches that SAME page rather
  // than the next one.
  let cursorBeforePage = startCursor;
  let resumeCursor: string | null = null;
  let resumeOffset = 0;
  let isFirstPageThisRun = true;

  for await (const { items: pageItems, endCursor, hasNextPage } of client.listAllProducts(startCursor)) {
    // The resume offset only applies to the very first page fetched this
    // run — any later page within the same run is fetched fresh and
    // starts at its own 0.
    const applyOffset = isFirstPageThisRun && startOffset > 0;
    const items = applyOffset ? pageItems.slice(startOffset) : pageItems;
    let indexInPage = applyOffset ? startOffset : 0;
    isFirstPageThisRun = false;

    resumeCursor = hasNextPage ? endCursor : null;
    resumeOffset = 0;

    for (const product of items) {
      if (processedThisRun >= MAX_PRODUCTS_PER_RUN) {
        capped = true;
        resumeCursor = cursorBeforePage;
        resumeOffset = indexInPage;
        break;
      }
      try {
        await syncOneProduct(product, locationIdMap, actor, summary);
      } catch {
        recordNote(summary, `Produit Shopify ${product.title} : échec de synchronisation.`);
        summary.failed++;
      }
      processedThisRun++;
      indexInPage++;
    }
    if (capped) break;
    cursorBeforePage = endCursor;
  }

  await prisma.integration.update({
    where: { id: integrationId },
    data: { config: { ...config, productsResumeCursor: resumeCursor, productsResumeOffset: resumeOffset } },
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
  product: ShopifyProduct,
  locationIdMap: Map<string, string>,
  actor: SyncActor,
  summary: SyncSummary
): Promise<void> {
  if (isSimpleProduct(product)) {
    await syncSimpleProduct(product, locationIdMap, actor, summary);
    return;
  }

  // The parent Product row of a variable product still needs a `price`
  // (non-nullable) even though real sellable prices live on its
  // ProductVariation rows — the lowest variant price is a common,
  // non-fabricated "from" price for this purpose, not an invented value.
  const variantPrices = product.variants.nodes.map((v) => Number(v.price)).filter((p) => Number.isFinite(p));
  const fields = {
    name: product.title,
    description: null as string | null,
    status: mapProductStatus(product.status),
    price: variantPrices.length > 0 ? Math.min(...variantPrices) : 0,
  };
  const existing = await prisma.product.findFirst({ where: { source: "SHOPIFY", externalId: product.id } });

  let productId: string;
  if (existing) {
    const changed = existing.name !== fields.name || existing.status !== fields.status || Number(existing.price) !== fields.price;
    if (changed) {
      await prisma.product.update({ where: { id: existing.id }, data: { name: fields.name, status: fields.status, price: fields.price } });
      summary.updated++;
    } else {
      summary.unchanged++;
    }
    productId = existing.id;
  } else {
    const created = await prisma.product.create({
      data: {
        name: fields.name,
        // The parent product row needs a unique sku even though, for a
        // variable product, the real sellable skus live on its
        // ProductVariation rows — reuse the product gid deterministically.
        sku: `SHOPIFY-${product.id.split("/").pop()}`,
        status: fields.status,
        price: fields.price,
        source: "SHOPIFY",
        externalId: product.id,
        trackInventory: false,
      },
    });
    productId = created.id;
    summary.imported++;
  }

  for (const variant of product.variants.nodes) {
    try {
      const outcome = await syncOneVariant(variant, productId, locationIdMap, actor);
      summary[outcome]++;
    } catch {
      recordNote(summary, `Variante Shopify ${variant.title} : échec de synchronisation.`);
      summary.failed++;
    }
  }
}

async function syncSimpleProduct(
  product: ShopifyProduct,
  locationIdMap: Map<string, string>,
  actor: SyncActor,
  summary: SyncSummary
): Promise<void> {
  const fields = mapSimpleProductFields(product);
  const existing = await prisma.product.findFirst({ where: { source: "SHOPIFY", externalId: product.id } });

  let productId: string;
  if (existing) {
    const changed =
      existing.name !== fields.name ||
      existing.description !== fields.description ||
      Number(existing.price) !== fields.price ||
      existing.status !== fields.status ||
      existing.trackInventory !== fields.trackInventory;

    if (changed) {
      const skuOwner = await prisma.product.findUnique({ where: { sku: fields.sku } });
      const sku = !skuOwner || skuOwner.id === existing.id ? fields.sku : existing.sku;
      await prisma.product.update({
        where: { id: existing.id },
        data: { name: fields.name, sku, description: fields.description, price: fields.price, status: fields.status, trackInventory: fields.trackInventory },
      });
      summary.updated++;
    } else {
      summary.unchanged++;
    }
    productId = existing.id;
  } else {
    const skuOwner = await prisma.product.findUnique({ where: { sku: fields.sku } });
    const sku = skuOwner ? `${fields.sku}-shop-${product.id.split("/").pop()}` : fields.sku;
    const created = await prisma.product.create({
      data: { name: fields.name, sku, description: fields.description, price: fields.price, status: fields.status, trackInventory: fields.trackInventory, source: "SHOPIFY", externalId: product.id },
    });
    productId = created.id;
    summary.imported++;
  }

  const variant = product.variants.nodes[0];
  if (!variant || !fields.trackInventory) return;
  await reconcileVariantStock(variant, { productId }, locationIdMap, actor);
}

async function syncOneVariant(
  variant: ShopifyVariant,
  productId: string,
  locationIdMap: Map<string, string>,
  actor: SyncActor
): Promise<"imported" | "updated" | "unchanged"> {
  const fields = mapVariantFields(variant);
  const existing = await prisma.productVariation.findFirst({ where: { source: "SHOPIFY", externalId: variant.id } });

  let variationId: string;
  let outcome: "imported" | "updated" | "unchanged";
  if (existing) {
    const priceChanged = Number(existing.price ?? 0) !== fields.price;
    const attrsChanged = JSON.stringify(existing.attributes) !== JSON.stringify({ Variante: variant.title });
    if (priceChanged || attrsChanged) {
      await prisma.productVariation.update({
        where: { id: existing.id },
        data: { price: fields.price, attributes: { Variante: variant.title } },
      });
      outcome = "updated";
    } else {
      outcome = "unchanged";
    }
    variationId = existing.id;
  } else {
    const skuOwner = await prisma.productVariation.findUnique({ where: { sku: fields.sku } });
    const sku = skuOwner ? `${fields.sku}-shop-${variant.id.split("/").pop()}` : fields.sku;
    const created = await prisma.productVariation.create({
      data: { productId, sku, price: fields.price, attributes: { Variante: variant.title }, source: "SHOPIFY", externalId: variant.id },
    });
    variationId = created.id;
    outcome = "imported";
  }

  if (fields.trackInventory) {
    await reconcileVariantStock(variant, { variationId }, locationIdMap, actor);
  }

  return outcome;
}

async function reconcileVariantStock(
  variant: ShopifyVariant,
  target: { productId?: string; variationId?: string },
  locationIdMap: Map<string, string>,
  actor: SyncActor
): Promise<void> {
  for (const [shopifyLocationId, warehouseId] of locationIdMap) {
    const available = availableFrom(variant.inventoryItem.inventoryLevels.nodes, shopifyLocationId);
    if (available == null) continue; // this variant isn't stocked at this location — not an error
    await reconcileStockFromProvider({
      ...target,
      warehouseId,
      externalQuantity: available,
      actor,
      source: "SHOPIFY",
      externalItemId: variant.inventoryItem.id,
    });
  }
}
