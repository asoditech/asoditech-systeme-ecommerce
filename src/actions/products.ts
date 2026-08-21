"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import {
  createProductSchema,
  updateProductSchema,
  createCategorySchema,
  createProductVariationSchema,
} from "@/lib/validation/product";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import type { Category } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function createProductAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("products.create");

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
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existingSku = await prisma.product.findUnique({ where: { sku: parsed.data.sku } });
  if (existingSku) {
    return actionError("Un produit avec ce SKU existe déjà.", { sku: ["SKU déjà utilisé."] });
  }

  let product;
  try {
    product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
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
          createdById: user.id,
        },
      });

      if (created.trackInventory) {
        const defaultWarehouse = await tx.warehouse.findFirst({ where: { isDefault: true } });
        if (defaultWarehouse) {
          await tx.inventoryItem.create({
            data: { warehouseId: defaultWarehouse.id, productId: created.id, quantityOnHand: 0 },
          });
        }
      }

      return created;
    });
  } catch (error) {
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

  if (parsed.data.sku !== existing.sku) {
    const skuTaken = await prisma.product.findUnique({ where: { sku: parsed.data.sku } });
    if (skuTaken) {
      return actionError("Un produit avec ce SKU existe déjà.", { sku: ["SKU déjà utilisé."] });
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

  const parsed = createCategorySchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description"),
    parentId: formData.get("parentId"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existingSlug = await prisma.category.findUnique({ where: { slug: parsed.data.slug } });
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

  const existingSku = await prisma.productVariation.findUnique({ where: { sku: parsed.data.sku } });
  if (existingSku) {
    return actionError("Un SKU de variation identique existe déjà.", { sku: ["SKU déjà utilisé."] });
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

      const defaultWarehouse = await tx.warehouse.findFirst({ where: { isDefault: true } });
      if (defaultWarehouse) {
        await tx.inventoryItem.create({
          data: { warehouseId: defaultWarehouse.id, variationId: created.id, quantityOnHand: 0 },
        });
      }

      return created;
    });
  } catch (error) {
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
