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
 */
export async function syncProducts(
  client: ShopifyClient,
  locationIdMap: Map<string, string>,
  actor: SyncActor
): Promise<SyncSummary> {
  const summary = emptySyncSummary();

  for await (const page of client.listAllProducts()) {
    for (const product of page) {
      try {
        await syncOneProduct(product, locationIdMap, actor, summary);
      } catch {
        recordNote(summary, `Produit Shopify ${product.title} : échec de synchronisation.`);
        summary.failed++;
      }
    }
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
