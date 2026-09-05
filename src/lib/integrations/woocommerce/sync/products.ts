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
  categoryIdMap: Map<number, string>,
  warehouseId: string | null,
  actor: SyncActor,
  summary: SyncSummary
): Promise<void> {
  const fields = mapProductFields(wc);
  const categoryId = wc.categories[0] ? (categoryIdMap.get(wc.categories[0].id) ?? null) : null;
  const externalId = String(wc.id);

  const existing = await prisma.product.findFirst({ where: { source: "WOOCOMMERCE", externalId } });

  let productId: string;
  if (existing) {
    const changed =
      existing.name !== fields.name ||
      existing.description !== fields.description ||
      Number(existing.price) !== fields.price ||
      (existing.salePrice ? Number(existing.salePrice) : null) !== fields.salePrice ||
      existing.status !== fields.status ||
      existing.trackInventory !== fields.trackInventory ||
      existing.categoryId !== categoryId;

    if (changed) {
      // A SKU collision against a *different* internal product (e.g. the
      // WooCommerce SKU was reused/renamed on the store side) must not
      // silently steal that other product's SKU — skip this field rather
      // than fail the whole item.
      const skuOwner = await prisma.product.findUnique({ where: { sku: fields.sku } });
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
        },
      });
      summary.updated++;
    } else {
      summary.unchanged++;
    }
    productId = existing.id;
  } else {
    const skuOwner = await prisma.product.findUnique({ where: { sku: fields.sku } });
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
  for await (const page of client.listAllProductVariations(wcProductId)) {
    for (const wcVar of page) {
      try {
        const outcome = await syncOneVariation(wcVar, productId, warehouseId, actor);
        summary[outcome]++;
      } catch {
        recordNote(summary, `Variation WooCommerce #${wcVar.id} : échec de synchronisation.`);
        summary.failed++;
      }
    }
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
    const skuOwner = await prisma.productVariation.findUnique({ where: { sku } });
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
