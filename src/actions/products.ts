"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { addBarcodeInTx, assertSkuFreeOfBarcodeAndSiblings, BarcodeError } from "@/lib/catalog/barcodes";
import { generateAttributeCombinations, attributesKey, suggestVariationSku } from "@/lib/catalog/variations";
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
  updateCategorySchema,
  createProductVariationSchema,
  generateVariationCombinationsSchema,
  updateVariationDetailsSchema,
  updateVariationSkuSchema,
  addProductImageSchema,
  removeProductImageSchema,
  setPrimaryProductImageSchema,
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

  // Optional pasted image link (Batch 3, Task 2) — same field, same rules
  // (http(s), valid URL) as the existing edit-form image path
  // (updateProductImageSchema/updateProductImageAction below); a create is
  // always INTERNE, so the provider-owned boundary never applies here.
  const imageUrlParsed = updateProductImageSchema.shape.imageUrl.safeParse(formData.get("imageUrl") ?? "");
  if (!imageUrlParsed.success) {
    return actionError("Champs invalides.", { imageUrl: imageUrlParsed.error.flatten().formErrors });
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

  // Best-effort, same as updateProductImageAction: the product itself is
  // already committed, so a bad image host must never roll back creation.
  if (imageUrlParsed.data) {
    await syncProductLeadImage(product.id, imageUrlParsed.data);
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
  revalidatePath("/catalogue/categories");
  return actionOk(category);
}

/**
 * A category synced from WooCommerce/Shopify (`source`/`externalId`) is
 * provider-owned exactly like a synced product's definition
 * (docs/adr/0017/0038, `externalSourceError` above) — the next sync would
 * silently overwrite a local edit, so it is refused here rather than
 * silently lost.
 */
export async function updateCategoryAction(formData: FormData): Promise<ActionResult<Category>> {
  const user = await requirePermissionForAction("products.edit");

  const existing = await prisma.category.findUnique({ where: { id: String(formData.get("id") ?? "") } });
  if (!existing) return actionError("Catégorie introuvable.");
  if (existing.source !== "INTERNE") {
    const platform = existing.source === "WOOCOMMERCE" ? "WooCommerce" : "Shopify";
    return actionError(`Cette catégorie provient de ${platform} — modifiez-la directement sur ${platform}, pas depuis ASODITECH.`);
  }

  const parsed = updateCategorySchema.safeParse({
    id: existing.id,
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description"),
    parentId: formData.get("parentId"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }
  if (parsed.data.parentId === existing.id) {
    return actionError("Une catégorie ne peut pas être sa propre catégorie parente.", { parentId: ["Choix invalide."] });
  }

  if (parsed.data.slug !== existing.slug) {
    const slugTaken = await prisma.category.findFirst({ where: { slug: parsed.data.slug, id: { not: existing.id } } });
    if (slugTaken) return actionError("Ce slug est déjà utilisé.", { slug: ["Slug déjà utilisé."] });
  }

  let category;
  try {
    category = await prisma.category.update({
      where: { id: existing.id },
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
    action: "category.updated",
    entityType: "Category",
    entityId: category.id,
    previousValue: { name: existing.name, slug: existing.slug },
    newValue: { name: category.name, slug: category.slug },
  });

  revalidatePath("/produits");
  revalidatePath("/catalogue/categories");
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
 * Server-authoritative uniqueness for a suggested SKU (Batch 4, Task 6):
 * reuses `assertSkuFreeOfBarcodeAndSiblings` — the same cross-table
 * (Product/ProductVariation/Barcode) guard every other SKU-writing path
 * already goes through — retrying with a numeric suffix until free. The
 * client-side suggestion is cosmetic only; this is what actually decides.
 */
async function resolveUniqueSku(candidate: string, reservedInBatch: Set<string>): Promise<string> {
  let sku = candidate;
  let n = 2;
  while (reservedInBatch.has(sku.toLowerCase()) || (await assertSkuFreeOfBarcodeAndSiblings(sku)) !== null) {
    sku = `${candidate}-${n}`;
    n++;
  }
  reservedInBatch.add(sku.toLowerCase());
  return sku;
}

/**
 * The combination generator's write side (Batch 4, Task 4) — computes the
 * full desired combination set from the given options, diffs it against
 * this product's EXISTING variations (by attribute set, not by row order),
 * and creates ONLY the new ones. Never touches, reorders, or removes an
 * existing variation — regenerating with a narrower option set simply
 * creates nothing new; removing an existing combination is a separate,
 * explicit action (`removeVariationAction`), never implicit here.
 *
 * Each new SKU is server-suggested (`suggestVariationSku`) then made
 * unique the same way a single manual variation already is. All rows are
 * created in ONE transaction, each with its own default-warehouse
 * `InventoryItem` — identical initialization to `createProductVariationAction`.
 */
export async function generateProductVariationsAction(input: {
  productId: string;
  options: { name: string; values: string[] }[];
}): Promise<ActionResult<{ created: number; skippedExisting: number }>> {
  const user = await requirePermissionForAction("products.edit");
  const parsed = generateVariationCombinationsSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!product) return actionError("Produit introuvable.");
  const sourceError = externalSourceError(product);
  if (sourceError) return actionError(sourceError);

  const desired = generateAttributeCombinations(parsed.data.options);
  if (desired.length === 0) return actionError("Aucune combinaison à générer.");

  const existing = await prisma.productVariation.findMany({
    where: { productId: product.id },
    select: { attributes: true },
  });
  const existingKeys = new Set(existing.map((v) => attributesKey(v.attributes as Record<string, unknown>)));
  const toCreate = desired.filter((combo) => !existingKeys.has(attributesKey(combo)));

  if (toCreate.length === 0) {
    return actionOk({ created: 0, skippedExisting: desired.length });
  }

  const reservedSkus = new Set<string>();
  const rows: { attributes: Record<string, string>; sku: string }[] = [];
  for (const combo of toCreate) {
    const suggestion = suggestVariationSku(product.reference ?? product.name, combo);
    const sku = await resolveUniqueSku(suggestion, reservedSkus);
    rows.push({ attributes: combo, sku });
  }

  let createdCount = 0;
  try {
    createdCount = await prisma.$transaction(async (tx) => {
      const defaultWarehouseId = await getDefaultWarehouseId(tx);
      for (const row of rows) {
        const created = await tx.productVariation.create({
          data: { productId: product.id, sku: row.sku, attributes: row.attributes },
        });
        if (defaultWarehouseId) {
          await tx.inventoryItem.create({
            data: { warehouseId: defaultWarehouseId, variationId: created.id, quantityOnHand: 0 },
          });
        }
      }
      return rows.length;
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return actionError("Une des combinaisons a un SKU déjà utilisé — réessayez.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: product.id,
    metadata: { variationsGenerated: createdCount, skus: rows.map((r) => r.sku) },
  });

  revalidatePath(`/produits/${product.id}`);
  return actionOk({ created: createdCount, skippedExisting: desired.length - toCreate.length });
}

/**
 * Updates the ASODITECH-owned fields of an EXISTING variation — cost (as
 * before), plus sale price / image / active state (Batch 4). Never sku/
 * attributes/price: those stay provider-owned once a variation is synced
 * (see each provider's sync/products.ts "Field ownership" note), exactly
 * like `updateProductOperationalSettingsAction` at the product level — this
 * is its variation-level counterpart, and works for a synced variation too.
 */
export async function updateVariationDetailsAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = updateVariationDetailsSchema.safeParse({
    id: formData.get("id"),
    cost: formData.get("cost") || undefined,
    salePrice: formData.get("salePrice") || undefined,
    imageUrl: formData.get("imageUrl") ?? "",
    isActive: formData.get("isActive") === "on" || formData.get("isActive") === "true",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.productVariation.findUnique({
    where: { id: parsed.data.id },
    include: { product: { select: { price: true } } },
  });
  if (!existing) return actionError("Variation introuvable.");

  // Same "a promo above the regular price is a data-entry mistake" rule as
  // Product.salePrice vs Product.price — the effective regular price here
  // is the variation's own `price` override if set, else the product's.
  const effectiveRegularPrice = Number(existing.price ?? existing.product.price);
  if (parsed.data.salePrice != null && parsed.data.salePrice > effectiveRegularPrice) {
    return actionError("Le prix promotionnel ne peut pas dépasser le prix normal de la variation.", {
      salePrice: ["Le prix promotionnel ne peut pas dépasser le prix normal."],
    });
  }

  const variation = await prisma.productVariation.update({
    where: { id: parsed.data.id },
    data: {
      cost: parsed.data.cost ?? null,
      salePrice: parsed.data.salePrice ?? null,
      imageUrl: parsed.data.imageUrl || null,
      isActive: parsed.data.isActive,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: existing.productId,
    metadata: { variationId: variation.id, sku: variation.sku, isActive: variation.isActive },
  });

  revalidatePath(`/produits/${existing.productId}`);
  return actionOk({ id: variation.id });
}

/**
 * Batch 11 — a variation's SKU, editable after creation (previously only
 * settable once, at creation time, via `createProductVariationAction` /
 * `generateProductVariationsAction`). Deliberately a SEPARATE action from
 * `updateVariationDetailsAction`, which never touches sku (see its own doc
 * comment) — this keeps that action's documented invariant intact rather
 * than special-casing sku into it.
 *
 * Blocked for a WooCommerce/Shopify-sourced variation, same rule as every
 * other identity field (`externalSourceError`): the sku there is
 * provider-owned and the next sync would just overwrite a manual edit.
 * Server-side uniqueness is authoritative — `assertSkuFreeOfBarcodeAndSiblings`
 * is the same cross-table (product/variation/barcode) check every other
 * SKU-writing path in this file already uses, with this variation excepted
 * from its own check.
 */
export async function updateVariationSkuAction(input: {
  id: string;
  sku: string;
}): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = updateVariationSkuSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.productVariation.findUnique({
    where: { id: parsed.data.id },
    include: { product: { select: { source: true } } },
  });
  if (!existing) return actionError("Variation introuvable.");
  const sourceError = externalSourceError(existing.product);
  if (sourceError) return actionError(sourceError);

  if (existing.sku === parsed.data.sku) {
    return actionOk({ id: existing.id });
  }

  const skuProblem = await assertSkuFreeOfBarcodeAndSiblings(parsed.data.sku, {
    kind: "variation",
    id: existing.id,
  });
  if (skuProblem) return actionError(skuProblem, { sku: ["SKU déjà utilisé."] });

  const variation = await prisma.productVariation.update({
    where: { id: existing.id },
    data: { sku: parsed.data.sku },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: existing.productId,
    previousValue: { variationSku: existing.sku },
    newValue: { variationSku: variation.sku },
  });

  revalidatePath(`/produits/${existing.productId}`);
  return actionOk({ id: variation.id });
}

/**
 * Removes a variation from active use — Batch 4, Task 4/11's "do not
 * silently delete an inventory-bearing variation" rule, mirroring
 * `removeProductAction`'s exact delete-vs-archive pattern one level down:
 * hard-delete only when NOTHING references it yet (no order line, no sale
 * line, no stock movement on any of its InventoryItem rows); otherwise
 * deactivate (`isActive: false`) so every historical record — reception,
 * order, sale, movement — stays fully readable.
 *
 * A provider-synced variation is never hard-deleted (its sku/attributes/
 * price stay provider-owned, and the next sync would just recreate or
 * re-link it via externalId) — "remove" always means deactivate for it,
 * the one ASODITECH-owned lifecycle field it has, regardless of history.
 */
export async function removeVariationAction(formData: FormData): Promise<ActionResult<{ id: string; deleted: boolean }>> {
  const user = await requirePermissionForAction("products.edit");

  const id = String(formData.get("id") ?? "");
  if (!id) return actionError("Variation invalide.");

  const variation = await prisma.productVariation.findUnique({
    where: { id },
    select: {
      id: true,
      productId: true,
      sku: true,
      source: true,
      isActive: true,
      _count: { select: { orderItems: true, saleLines: true } },
    },
  });
  if (!variation) return actionError("Variation introuvable.");

  if (variation.source !== "INTERNE") {
    if (!variation.isActive) return actionOk({ id, deleted: false });
    await prisma.productVariation.update({ where: { id }, data: { isActive: false } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "product.updated",
      entityType: "Product",
      entityId: variation.productId,
      metadata: { variationId: id, sku: variation.sku, removed: "deactivated", reason: "provider_owned" },
    });
    revalidatePath(`/produits/${variation.productId}`);
    return actionOk({ id, deleted: false });
  }

  const movementCount = await prisma.inventoryMovement.count({ where: { inventoryItem: { variationId: id } } });
  const usedCount = variation._count.orderItems + variation._count.saleLines + movementCount;

  if (usedCount === 0) {
    await prisma.productVariation.delete({ where: { id } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "product.updated",
      entityType: "Product",
      entityId: variation.productId,
      metadata: { variationId: id, sku: variation.sku, removed: "deleted" },
    });
    revalidatePath(`/produits/${variation.productId}`);
    return actionOk({ id, deleted: true });
  }

  await prisma.productVariation.update({ where: { id }, data: { isActive: false } });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: variation.productId,
    metadata: { variationId: id, sku: variation.sku, removed: "deactivated", usedCount },
  });
  revalidatePath(`/produits/${variation.productId}`);
  return actionOk({ id, deleted: false });
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
 * Batch 11 — product image GALLERY (`ProductImage[]`), additive on top of
 * the pre-existing single "lead" position-0 image the WooCommerce/Shopify
 * sync owns (`syncProductLeadImage`). Only the position-0 row is ever
 * touched by a sync (see that helper's own doc comment: "never touches...
 * a product's other, non-position-0 images"), so every image this action
 * (and the two below) manage is one this app's own sync never reaches —
 * but, matching the pre-existing single-image form's own gate, still kept
 * INTERNE-only for now: there is no UI surface for it on a synced product
 * in this batch, and adding one is a small, separate, low-risk follow-up
 * (see the final report's "discovered out-of-scope" section) rather than
 * something to decide silently here.
 *
 * Always APPENDS (never overwrites in place, unlike the old single-image
 * form) — at `(max existing position for this product) + 1`, or `0` when
 * the product has no images at all yet.
 */
export async function addProductImageAction(input: {
  productId: string;
  imageUrl: string;
}): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = addProductImageSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!product) return actionError("Produit introuvable.");
  const sourceError = externalSourceError(product);
  if (sourceError) return actionError(sourceError);

  const last = await prisma.productImage.findFirst({
    where: { productId: product.id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const image = await prisma.productImage.create({
    data: { productId: product.id, url: parsed.data.imageUrl, position: last ? last.position + 1 : 0 },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: product.id,
    metadata: { imageAdded: image.id, position: image.position },
  });

  revalidatePath(`/produits/${product.id}`);
  revalidatePath("/produits");
  return actionOk({ id: image.id });
}

/**
 * Batch 11 — removes one image from the gallery. INTERNE-only (see
 * `addProductImageAction`'s own doc comment); removing the lead (position
 * 0) image of a synced product must go through the sync instead, exactly
 * like `updateProductImageAction` already refuses to touch it directly.
 */
export async function removeProductImageAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = removeProductImageSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const image = await prisma.productImage.findUnique({
    where: { id: parsed.data.id },
    include: { product: { select: { id: true, source: true } } },
  });
  if (!image) return actionError("Image introuvable.");
  const sourceError = externalSourceError(image.product);
  if (sourceError) return actionError(sourceError);

  await prisma.productImage.delete({ where: { id: image.id } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: image.productId,
    metadata: { imageRemoved: image.id, position: image.position },
  });

  revalidatePath(`/produits/${image.productId}`);
  revalidatePath("/produits");
  return actionOk({ id: image.productId });
}

/**
 * Batch 11 — promotes one gallery image to position 0 ("Principal"), the
 * position the product list thumbnail / hover preview and the WooCommerce/
 * Shopify sync both read as the product's lead image. Swaps positions with
 * whatever currently holds position 0 (if any) rather than renumbering the
 * whole gallery — `ProductImage` has no unique constraint on
 * `(productId, position)`, so the two updates in this transaction can never
 * conflict with each other regardless of order.
 */
export async function setPrimaryProductImageAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.edit");

  const parsed = setPrimaryProductImageSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const image = await prisma.productImage.findUnique({
    where: { id: parsed.data.id },
    include: { product: { select: { id: true, source: true } } },
  });
  if (!image) return actionError("Image introuvable.");
  const sourceError = externalSourceError(image.product);
  if (sourceError) return actionError(sourceError);

  if (image.position !== 0) {
    const currentLead = await prisma.productImage.findFirst({
      where: { productId: image.productId, position: 0 },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      if (currentLead) {
        await tx.productImage.update({ where: { id: currentLead.id }, data: { position: image.position } });
      }
      await tx.productImage.update({ where: { id: image.id }, data: { position: 0 } });
    });
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.updated",
    entityType: "Product",
    entityId: image.productId,
    metadata: { imageSetPrimary: image.id },
  });

  revalidatePath(`/produits/${image.productId}`);
  revalidatePath("/produits");
  return actionOk({ id: image.productId });
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
