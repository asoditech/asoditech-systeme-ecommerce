"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { addBarcodeInTx, assertSkuFreeOfBarcodeAndSiblings, BarcodeError } from "@/lib/catalog/barcodes";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { recordAuditEvent } from "@/lib/audit";
import { getDefaultWarehouseId } from "@/lib/inventory";
import {
  createProductSchema,
  updateProductSchema,
  updateProductOperationalSettingsSchema,
  updateVariationOperationalSettingsSchema,
  updateProductImageSchema,
  createCategorySchema,
  createProductVariationSchema,
} from "@/lib/validation/product";
import { syncProductLeadImage } from "@/lib/integrations/shared";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import type { Category, Product } from "@prisma/client";

/**
 * Product *definition* (name/sku/price/description/status/category) is
 * owned by whichever platform the product actually lives on once it's
 * externally sourced — ASODITECH is not a second WooCommerce/Shopify
 * editor. See docs/adr/0017-product-management-boundary.md. Used by
 * every action below that would otherwise let staff edit those fields
 * from here, where the change would just be silently overwritten by the
 * next sync — the real enforcement point, not just a hidden UI button;
 * the ASODITECH-owned operational fields (cost/trackInventory/
 * lowStockThreshold — see updateProductOperationalSettingsAction) are
 * unaffected by this guard.
 */
function externalSourceError(product: Pick<Product, "source">): string | null {
  if (product.source === "INTERNE") return null;
  const platform = product.source === "WOOCOMMERCE" ? "WooCommerce" : "Shopify";
  return `Ce produit provient de ${platform} — modifiez sa fiche directement sur ${platform}, pas depuis ASODITECH.`;
}

/** "Chaussures Homme" → "chaussures-homme". Deterministic; collisions are caught by the slug pre-check. */
function slugifyCategoryName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function createProductAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.create");
  // Tenant business mode (docs/adr/0041): the identity/availability inputs below
  // exist only in an ONLINE_AND_OFFLINE tenant. In ONLINE_ONLY they are IGNORED
  // — a request carrying them behaves exactly like the pre-existing form.
  const identityOn = user.capabilities.has("catalogIdentity");
  const channelsOn = user.capabilities.has("storeChannels");

  const parsed = createProductSchema.safeParse({
    name: formData.get("name"),
    sku: formData.get("sku"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    price: formData.get("price"),
    salePrice: formData.get("salePrice") || undefined,
    cost: formData.get("cost") || undefined,
    status: formData.get("status") || "BROUILLON",
    trackInventory: formData.get("trackInventory") === "on",
    lowStockThreshold: formData.get("lowStockThreshold") || 5,
    // Identity + availability (docs/adr/0038) — all optional, mode-gated (ADR 0041).
    reference: identityOn ? formData.get("reference") : null,
    barcode: identityOn ? formData.get("barcode") : null,
    salesChannelIds: channelsOn ? formData.getAll("salesChannelIds").map(String).filter(Boolean) : [],
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // Cross-table reference guard (docs/adr/0038): sku is unique per table, so
  // also refuse a SKU already used by a variation or by a barcode. For the
  // plain "product with this SKU exists" case the message is unchanged.
  const skuProblem = await assertSkuFreeOfBarcodeAndSiblings(parsed.data.sku);
  if (skuProblem) {
    return actionError(skuProblem, { sku: ["SKU déjà utilisé."] });
  }
  const newBarcode = parsed.data.barcode && parsed.data.barcode.trim().length > 0 ? parsed.data.barcode.trim() : null;
  if (newBarcode && (await prisma.barcode.findFirst({ where: { code: newBarcode }, select: { id: true } }))) {
    return actionError("Ce code-barres est déjà utilisé.", { barcode: ["Code-barres déjà utilisé."] });
  }

  // Channel availability. A form that submitted the channel checkboxes
  // (`channelsSubmitted`) is honoured exactly, INCLUDING "none". Every other
  // caller keeps the pre-existing behaviour: a new product is sellable
  // through the default ONLINE channel.
  const channelsSubmitted = channelsOn && formData.get("channelsSubmitted") === "1";
  let channelIds: string[] = parsed.data.salesChannelIds ?? [];
  if (channelIds.length > 0) {
    const found = await prisma.salesChannel.findMany({ where: { id: { in: channelIds }, isActive: true }, select: { id: true } });
    if (found.length !== new Set(channelIds).size) return actionError("Canal de vente introuvable ou inactif.");
    channelIds = found.map((c) => c.id);
  }

  let product;
  try {
    product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          name: parsed.data.name,
          sku: parsed.data.sku,
          reference: normalizeOptional(parsed.data.reference),
          description: normalizeOptional(parsed.data.description),
          categoryId: normalizeOptional(parsed.data.categoryId),
          price: parsed.data.price,
          salePrice: parsed.data.salePrice ?? null,
          cost: parsed.data.cost ?? null,
          status: parsed.data.status,
          trackInventory: parsed.data.trackInventory,
          lowStockThreshold: parsed.data.lowStockThreshold,
          createdById: user.id,
          // Created here, now — so it sorts alongside imported products,
          // which carry their platform's own creation date.
          platformCreatedAt: new Date(),
        },
      });

      if (created.trackInventory) {
        const defaultWarehouseId = await getDefaultWarehouseId(tx);
        if (defaultWarehouseId) {
          await tx.inventoryItem.create({
            data: { warehouseId: defaultWarehouseId, productId: created.id, quantityOnHand: 0 },
          });
        }
      }

      // Identity + availability, atomically with the product (docs/adr/0038).
      if (newBarcode) {
        await addBarcodeInTx(tx, { productId: created.id, code: newBarcode, createdById: user.id });
      }
      const targetChannelIds = channelsSubmitted ? channelIds : channelIds.length > 0 ? channelIds : [(await ensureDefaultOnlineChannel(tx)).id];
      if (targetChannelIds.length > 0) {
        await tx.productSalesChannel.createMany({
          data: targetChannelIds.map((salesChannelId) => ({ productId: created.id, salesChannelId })),
          skipDuplicates: true,
        });
      }

      return created;
    });
  } catch (error) {
    if (error instanceof BarcodeError) {
      return actionError(error.message, { barcode: [error.message] });
    }
    // Backstop for the rare race where two concurrent requests both pass
    // the findUnique pre-check above before either commits. Found during
    // the A–G audit; see docs/adr/0002-domain-model.md's audit addendum.
    if (isUniqueConstraintError(error)) {
      return actionError("Un produit avec ce SKU existe déjà.", { sku: ["SKU déjà utilisé."] });
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.created",
    entityType: "Product",
    entityId: product.id,
    newValue: { name: product.name, sku: product.sku },
  });

  revalidatePath("/produits");
  return actionOk({ id: product.id });
}

export async function updateProductAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = updateProductSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    sku: formData.get("sku"),
    description: formData.get("description"),
    categoryId: formData.get("categoryId"),
    price: formData.get("price"),
    salePrice: formData.get("salePrice") || undefined,
    cost: formData.get("cost") || undefined,
    status: formData.get("status") || "BROUILLON",
    trackInventory: formData.get("trackInventory") === "on",
    lowStockThreshold: formData.get("lowStockThreshold") || 5,
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.product.findUnique({ where: { id: parsed.data.id } });
  if (!existing) {
    return actionError("Produit introuvable.");
  }
  const sourceError = externalSourceError(existing);
  if (sourceError) return actionError(sourceError);

  if (parsed.data.sku !== existing.sku) {
    const skuProblem = await assertSkuFreeOfBarcodeAndSiblings(parsed.data.sku, { kind: "product", id: existing.id });
    if (skuProblem) {
      return actionError(skuProblem, { sku: ["SKU déjà utilisé."] });
    }
  }

  let product;
  try {
    product = await prisma.product.update({
      where: { id: parsed.data.id },
      data: {
        name: parsed.data.name,
        sku: parsed.data.sku,
        description: normalizeOptional(parsed.data.description),
        categoryId: normalizeOptional(parsed.data.categoryId),
        price: parsed.data.price,
        salePrice: parsed.data.salePrice ?? null,
        cost: parsed.data.cost ?? null,
        status: parsed.data.status,
        trackInventory: parsed.data.trackInventory,
        lowStockThreshold: parsed.data.lowStockThreshold,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return actionError("Un produit avec ce SKU existe déjà.", { sku: ["SKU déjà utilisé."] });
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: existing.status !== product.status && product.status === "ARCHIVE" ? "product.archived" : "product.updated",
    entityType: "Product",
    entityId: product.id,
    previousValue: { price: existing.price.toString(), status: existing.status },
    newValue: { price: product.price.toString(), status: product.status },
  });

  revalidatePath("/produits");
  revalidatePath(`/produits/${product.id}`);
  return actionOk({ id: product.id });
}

export async function createCategoryAction(formData: FormData): Promise<ActionResult<Category>> {
  const user = await requirePermissionForAction("products.create");

  const rawSlug = String(formData.get("slug") ?? "").trim();
  const rawName = String(formData.get("name") ?? "");
  const parsed = createCategorySchema.safeParse({
    name: formData.get("name"),
    // Inline creation from the product form sends only a name — derive the
    // slug from it (lowercase, accents stripped, non-alphanumerics → "-").
    // (ONLINE_ONLY tenants keep the historical contract: an explicit slug is
    // required — docs/adr/0041.)
    slug: rawSlug || (user.capabilities.has("catalogIdentity") ? slugifyCategoryName(rawName) : ""),
    description: formData.get("description"),
    parentId: formData.get("parentId"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existingSlug = await prisma.category.findFirst({ where: { slug: parsed.data.slug } });
  if (existingSlug) {
    return actionError("Ce slug est déjà utilisé.", { slug: ["Slug déjà utilisé."] });
  }

  let category;
  try {
    category = await prisma.category.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        description: normalizeOptional(parsed.data.description),
        parentId: normalizeOptional(parsed.data.parentId),
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return actionError("Ce slug est déjà utilisé.", { slug: ["Slug déjà utilisé."] });
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "category.created",
    entityType: "Category",
    entityId: category.id,
    newValue: { name: category.name },
  });

  revalidatePath("/produits");
  return actionOk(category);
}

export async function createProductVariationAction(
  formData: FormData
): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const attributesRaw = formData.get("attributes");
  let attributes: Record<string, string> = {};
  try {
    attributes = attributesRaw ? JSON.parse(String(attributesRaw)) : {};
  } catch {
    return actionError("Attributs invalides.");
  }

  const parsed = createProductVariationSchema.safeParse({
    productId: formData.get("productId"),
    sku: formData.get("sku"),
    attributes,
    price: formData.get("price") || undefined,
    cost: formData.get("cost") || undefined,
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!product) return actionError("Produit introuvable.");
  const sourceError = externalSourceError(product);
  if (sourceError) return actionError(sourceError);

  const existingSku = await prisma.productVariation.findFirst({ where: { sku: parsed.data.sku } });
  if (existingSku) {
    return actionError("Un SKU de variation identique existe déjà.", { sku: ["SKU déjà utilisé."] });
  }
  // Cross-table guard (docs/adr/0038): a variation SKU may not equal a
  // product SKU or a barcode either.
  const crossTableProblem = await assertSkuFreeOfBarcodeAndSiblings(parsed.data.sku);
  if (crossTableProblem) {
    return actionError(crossTableProblem, { sku: ["SKU déjà utilisé."] });
  }
  const variationBarcode = user.capabilities.has("catalogIdentity") ? String(formData.get("barcode") ?? "").trim() || null : null;
  if (variationBarcode && (await prisma.barcode.findFirst({ where: { code: variationBarcode }, select: { id: true } }))) {
    return actionError("Ce code-barres est déjà utilisé.", { barcode: ["Code-barres déjà utilisé."] });
  }

  let variation;
  try {
    variation = await prisma.$transaction(async (tx) => {
      const created = await tx.productVariation.create({
        data: {
          productId: parsed.data.productId,
          sku: parsed.data.sku,
          attributes: parsed.data.attributes,
          price: parsed.data.price ?? null,
          cost: parsed.data.cost ?? null,
        },
      });

      const defaultWarehouseId = await getDefaultWarehouseId(tx);
      if (defaultWarehouseId) {
        await tx.inventoryItem.create({
          data: { warehouseId: defaultWarehouseId, variationId: created.id, quantityOnHand: 0 },
        });
      }

      if (variationBarcode) {
        await addBarcodeInTx(tx, { variationId: created.id, code: variationBarcode, createdById: user.id });
      }

      return created;
    });
  } catch (error) {
    if (error instanceof BarcodeError) {
      return actionError(error.message, { barcode: [error.message] });
    }
    if (isUniqueConstraintError(error)) {
      return actionError("Un SKU de variation identique existe déjà.", { sku: ["SKU déjà utilisé."] });
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: parsed.data.productId,
    metadata: { variationAdded: variation.sku },
  });

  revalidatePath(`/produits/${parsed.data.productId}`);
  return actionOk({ id: variation.id });
}

/**
 * Updates only the fields ASODITECH owns regardless of where a product's
 * definition lives — cost, inventory tracking, and the low-stock
 * threshold (see updateProductOperationalSettingsSchema). Unlike
 * updateProductAction, this works for a WooCommerce/Shopify-sourced
 * product too: these are never touched by either sync (see each
 * provider's mapper.ts "Field ownership" comment), so nothing here can be
 * silently overwritten by the next import. See
 * docs/adr/0017-product-management-boundary.md.
 */
export async function updateProductOperationalSettingsAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = updateProductOperationalSettingsSchema.safeParse({
    id: formData.get("id"),
    cost: formData.get("cost") || undefined,
    trackInventory: formData.get("trackInventory") === "on",
    lowStockThreshold: formData.get("lowStockThreshold") || 5,
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.product.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Produit introuvable.");

  const product = await prisma.product.update({
    where: { id: parsed.data.id },
    data: {
      cost: parsed.data.cost ?? null,
      trackInventory: parsed.data.trackInventory,
      lowStockThreshold: parsed.data.lowStockThreshold,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: product.id,
    previousValue: { cost: existing.cost?.toString() ?? null, trackInventory: existing.trackInventory, lowStockThreshold: existing.lowStockThreshold },
    newValue: { cost: product.cost?.toString() ?? null, trackInventory: product.trackInventory, lowStockThreshold: product.lowStockThreshold },
  });

  revalidatePath(`/produits/${product.id}`);
  return actionOk({ id: product.id });
}

/**
 * The manual image path for an INTERNE product — there is no file-upload
 * backend in this app, so this is a pasted image link, not an upload.
 * Blocked for a WooCommerce/Shopify-sourced product (`externalSourceError`):
 * those get their image from the sync instead, and the next sync would
 * silently overwrite a manual one anyway (docs/adr/0010/0011). Empty
 * `imageUrl` clears the image.
 */
export async function updateProductImageAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = updateProductImageSchema.safeParse({
    id: formData.get("id"),
    imageUrl: formData.get("imageUrl") ?? "",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const product = await prisma.product.findUnique({ where: { id: parsed.data.id } });
  if (!product) return actionError("Produit introuvable.");
  const sourceError = externalSourceError(product);
  if (sourceError) return actionError(sourceError);

  await syncProductLeadImage(product.id, parsed.data.imageUrl || null);

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: product.id,
    metadata: { imageUrl: parsed.data.imageUrl || null },
  });

  revalidatePath(`/produits/${product.id}`);
  revalidatePath("/produits");
  return actionOk({ id: product.id });
}

/**
 * Per-variation `cost` — the only variation field ASODITECH owns for an
 * externally-sourced variable product (WooCommerce/Shopify never sync it,
 * see each mapper's "Field ownership" note). Lets the operator enter the
 * purchase cost per colour/size so margin and realised profit work for
 * variable products, not just simple ones. Also updates the parent
 * product's audit trail so the change is traceable.
 */
export async function updateVariationOperationalSettingsAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = updateVariationOperationalSettingsSchema.safeParse({
    id: formData.get("id"),
    cost: formData.get("cost") || undefined,
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.productVariation.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Variation introuvable.");

  const variation = await prisma.productVariation.update({
    where: { id: parsed.data.id },
    data: { cost: parsed.data.cost ?? null },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: variation.productId,
    previousValue: { variation: existing.sku, cost: existing.cost?.toString() ?? null },
    newValue: { variation: variation.sku, cost: variation.cost?.toString() ?? null },
  });

  revalidatePath(`/produits/${variation.productId}`);
  return actionOk({ id: variation.id });
}

/**
 * Removes a product that no longer belongs in the catalogue — typically
 * one deleted from the connected store (the `product.deleted` webhook does
 * this automatically, but a missed webhook or a manual clean-up needs a
 * button). If the product was never sold it is deleted outright
 * (variations, images and stock rows cascade); otherwise it is archived,
 * so its order history keeps a live link. Works for internal and
 * external products alike — a product deleted upstream has no owner left.
 */
export async function removeProductAction(formData: FormData): Promise<ActionResult<{ id: string; deleted: boolean }>> {
  const user = await requirePermissionForAction("products.edit");

  const productId = String(formData.get("productId") ?? "");
  if (!productId) return actionError("Produit invalide.");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true, source: true, status: true, _count: { select: { orderItems: true } } },
  });
  if (!product) return actionError("Produit introuvable.");

  const soldCount = product._count.orderItems;
  // Ledger protection (docs/adr/0038): InventoryItem and InventoryMovement
  // cascade from Product/ProductVariation, so hard-deleting a product that
  // ever had a stock movement (a reception, a transfer, a count, an
  // adjustment, an offline sale...) would silently destroy its audit
  // trail even though it was never sold through an order. Any movement —
  // on the product itself or on any of its variations — means "archive".
  const movementCount = await prisma.inventoryMovement.count({
    where: { inventoryItem: { OR: [{ productId }, { variation: { productId } }] } },
  });
  if (soldCount === 0 && movementCount === 0) {
    await prisma.product.delete({ where: { id: productId } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "product.archived",
      entityType: "Product",
      entityId: productId,
      metadata: { name: product.name, source: product.source, removed: "deleted", reason: "manual_cleanup" },
    });
    revalidatePath("/produits");
    return actionOk({ id: productId, deleted: true });
  }

  if (product.status !== "ARCHIVE") {
    await prisma.product.update({ where: { id: productId }, data: { status: "ARCHIVE" } });
  }
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.archived",
    entityType: "Product",
    entityId: productId,
    metadata: {
      name: product.name,
      source: product.source,
      removed: "archived",
      soldCount,
      movementCount,
      reason: "manual_cleanup",
    },
  });
  revalidatePath("/produits");
  revalidatePath(`/produits/${productId}`);
  return actionOk({ id: productId, deleted: false });
}

/**
 * Backfills `OrderItem.costSnapshot` on this product's PAST sales that
 * currently have none — using the product's (or the variation's) cost as
 * it stands NOW. Deliberate override: it *does* change historical
 * profitability, so it's an explicit button, not automatic. Only ever
 * fills a null snapshot — a line that already carries a cost is left
 * untouched. Skips cancelled / failed / returned / refunded orders.
 */
export async function backfillProductCostSnapshotsAction(
  formData: FormData
): Promise<ActionResult<{ id: string; updated: number }>> {
  const user = await requirePermissionForAction("products.edit");

  const productId = String(formData.get("productId") ?? "");
  if (!productId) return actionError("Produit invalide.");

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, cost: true, variations: { select: { id: true, cost: true } } },
  });
  if (!product) return actionError("Produit introuvable.");
  if (product.cost === null && product.variations.every((v) => v.cost === null)) {
    return actionError("Renseignez d'abord le coût d'achat du produit.");
  }

  const EXCLUDED = ["ANNULEE", "ECHEC", "RETOUR", "REMBOURSEE"] as const;
  const variationCost = new Map(product.variations.map((v) => [v.id, v.cost ?? product.cost]));

  const lines = await prisma.orderItem.findMany({
    where: { productId, costSnapshot: null, order: { status: { notIn: [...EXCLUDED] } } },
    select: { id: true, variationId: true },
  });

  let updated = 0;
  for (const line of lines) {
    const cost = line.variationId ? variationCost.get(line.variationId) ?? product.cost : product.cost;
    if (cost === null) continue;
    await prisma.orderItem.update({ where: { id: line.id }, data: { costSnapshot: cost } });
    updated++;
  }

  if (updated > 0) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "product.updated",
      entityType: "Product",
      entityId: productId,
      metadata: { costSnapshotBackfill: updated },
    });
  }

  revalidatePath(`/produits/${productId}`);
  revalidatePath("/finance");
  revalidatePath("/analyses");
  return actionOk({ id: productId, updated });
}
