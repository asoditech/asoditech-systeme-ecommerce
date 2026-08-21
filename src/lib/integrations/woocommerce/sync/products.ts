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
 */
export async function syncProducts(
  client: WooCommerceClient,
  categoryIdMap: Map<number, string>,
  actor: SyncActor
): Promise<SyncSummary> {
  const summary = emptySyncSummary();
  const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });

  for await (const page of client.listAllProducts()) {
    for (const wc of page) {
      try {
        await syncOneProduct(client, wc, categoryIdMap, warehouse?.id ?? null, actor, summary);
      } catch {
        recordNote(summary, `Produit WooCommerce #${wc.id} (${wc.sku || wc.name}) : échec de synchronisation.`);
        summary.failed++;
      }
    }
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
