"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { publishProductSchema } from "@/lib/validation/product";
import { checkProductPublishEligibility, resolveExternalAdminUrl } from "@/lib/integrations/shared";
import { isShopifyIntegrationEnabled, SHOPIFY_DISABLED_MESSAGE } from "@/lib/integrations/shopify/feature-flag";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { loadShopifyClient } from "@/lib/integrations/shopify/client-loader";
import { WooCommerceError } from "@/lib/integrations/woocommerce/errors";
import { ShopifyError } from "@/lib/integrations/shopify/errors";
import {
  buildWooCommerceProductPayload,
  buildWooCommerceVariationPayload,
  type PublishableProductInput as WooProductInput,
  type PublishableVariationInput,
} from "@/lib/integrations/woocommerce/mapper";
import { buildShopifyProductCreateInput } from "@/lib/integrations/shopify/mapper";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * Batch 13 — Product Publishing / External Catalog.
 *
 * Publishes an INTERNE-master, eligible ASODITECH `Product` to a connected
 * WooCommerce or Shopify channel, EXPLICITLY (never as a side effect of
 * create/edit/save — see this batch's own Section 3). Deliberately never
 * touches `InventoryItem`/`InventoryMovement`: this is catalogue
 * synchronization, not a stock event (docs/adr/0036 is untouched).
 *
 * Server-authorized: `products.edit` (may this user edit products at all)
 * AND `integrations.manage` (may this user perform an external-integration
 * mutation) — the same dual-permission shape already used elsewhere in this
 * app for a sensitive cross-cutting action (docs/adr/0035's RBAC+entitlement
 * pattern), reusing two existing permissions rather than inventing a third.
 */
export interface PublishProductResult {
  externalId: string;
  adminUrl: string | null;
}

export async function publishProductAction(input: {
  productId: string;
  provider: "WOOCOMMERCE" | "SHOPIFY";
}): Promise<ActionResult<PublishProductResult>> {
  const user = await requirePermissionForAction("products.edit");
  if (!userHasPermission(user, "integrations.manage")) {
    return actionError("Vous n'avez pas la permission de publier un produit sur un canal externe.");
  }

  const parsed = publishProductSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  const { productId, provider } = parsed.data;

  // The Shopify kill switch (client feedback #10, src/lib/integrations/shopify/feature-flag.ts)
  // governs every Shopify entry point app-wide — publishing is no exception.
  if (provider === "SHOPIFY" && !isShopifyIntegrationEnabled()) {
    return actionError(SHOPIFY_DISABLED_MESSAGE);
  }

  // Tenant-scoped by the Prisma extension (docs/adr/0024) — a productId
  // belonging to another tenant simply isn't found, exactly like every
  // other action in this app.
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      images: { orderBy: { position: "asc" }, take: 1 },
      variations: { where: { isActive: true } },
      category: { select: { source: true, externalId: true } },
    },
  });
  if (!product) return actionError("Produit introuvable.");

  // Duplicate-publish protection (Section 11): one row per (product,
  // provider) already existing means this exact channel was already
  // published to — never silently create a second external product.
  const existing = await prisma.productPublication.findUnique({
    where: { tenantId_productId_provider: { tenantId: product.tenantId, productId: product.id, provider } },
  });
  if (existing) {
    return actionError(
      `Ce produit est déjà publié sur ${provider === "WOOCOMMERCE" ? "WooCommerce" : "Shopify"}.`
    );
  }

  const eligibility = checkProductPublishEligibility(
    { status: product.status, price: Number(product.price), variationCount: product.variations.length },
    provider
  );
  if (!eligibility.eligible) {
    return actionError(
      `Impossible de publier ce produit. Champs manquants : ${eligibility.missingFields.join(", ")}.`
    );
  }

  const providerLabel = provider === "WOOCOMMERCE" ? "WooCommerce" : "Shopify";
  const variationInputs: PublishableVariationInput[] = product.variations.map((v) => ({
    sku: v.sku,
    price: v.price != null ? Number(v.price) : null,
    salePrice: v.salePrice != null ? Number(v.salePrice) : null,
    attributes: v.attributes as Record<string, string>,
  }));

  let externalId: string;
  try {
    if (provider === "WOOCOMMERCE") {
      const loaded = await loadWooCommerceClient();
      if (!loaded) {
        return actionError(`Aucun canal ${providerLabel} connecté. Connectez-le d'abord dans Intégrations.`);
      }
      // `load*Client()` only checks credentials/config are present (it is
      // shared with the automatic stock-push path, which must tolerate a
      // stale status) — publishing additionally requires a REAL verified
      // connection, never merely saved credentials (docs/adr/0004's
      // CONFIGURE vs CONNECTE).
      if (loaded.integration.status !== "CONNECTE") {
        return actionError(`Le canal ${providerLabel} n'est pas connecté. Testez la connexion dans Intégrations.`);
      }
      const wooCategoryId =
        product.category?.source === "WOOCOMMERCE" && product.category.externalId
          ? Number(product.category.externalId)
          : null;
      const productInput: WooProductInput = {
        name: product.name,
        sku: product.sku,
        description: product.description,
        price: Number(product.price),
        salePrice: product.salePrice != null ? Number(product.salePrice) : null,
        images: product.images.map((img) => ({ url: img.url })),
        wooCategoryId,
      };
      const payload = buildWooCommerceProductPayload(productInput, variationInputs);
      const created = await loaded.client.createProduct(payload);
      if (variationInputs.length > 0) {
        // Sequential, not Promise.all — WooCommerce's REST API has no batch
        // variation-create endpoint, and creating them one at a time avoids
        // hitting the store with a burst of concurrent requests.
        for (const v of variationInputs) {
          await loaded.client.createProductVariation(
            created.id,
            buildWooCommerceVariationPayload(v, Number(product.price))
          );
        }
      }
      externalId = String(created.id);
    } else {
      const loaded = await loadShopifyClient();
      if (!loaded) {
        return actionError(`Aucun canal ${providerLabel} connecté. Connectez-le d'abord dans Intégrations.`);
      }
      if (loaded.integration.status !== "CONNECTE") {
        return actionError(`Le canal ${providerLabel} n'est pas connecté. Testez la connexion dans Intégrations.`);
      }
      const created = await loaded.client.createProduct(
        buildShopifyProductCreateInput({ name: product.name, description: product.description })
      );
      await loaded.client.updateVariantPriceAndSku(created.productId, created.defaultVariantId, {
        price: (product.salePrice ?? product.price).toString(),
        sku: product.sku,
      });
      externalId = created.productId;
    }
  } catch (error) {
    if (error instanceof WooCommerceError || error instanceof ShopifyError) {
      return actionError(`Publication impossible. ${providerLabel} a refusé le produit : ${error.message}`);
    }
    throw error;
  }

  // The external product now genuinely exists — only report success once
  // the local record of it is safely persisted too (Section 28: never
  // claim "Published" if local persistence then fails).
  try {
    await prisma.productPublication.create({
      data: { productId: product.id, provider, externalId, publishedById: user.id, publishedByName: user.name },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Lost a race against a concurrent publish of the same product+provider
      // — the winner's row is the answer; the external product THIS request
      // just created is an orphan on the provider's side (rare, and safer
      // than corrupting the one identity row two requests would otherwise
      // fight over — see this action's own duplicate-protection doc comment).
      const winner = await prisma.productPublication.findUnique({
        where: { tenantId_productId_provider: { tenantId: product.tenantId, productId: product.id, provider } },
      });
      if (winner) {
        return actionError(
          `Ce produit vient d'être publié sur ${providerLabel} par une autre action. Rechargez la page.`
        );
      }
    }
    return actionError(
      `Le produit a été créé sur ${providerLabel} (référence ${externalId}) mais son enregistrement local a échoué. Contactez le support avec cette référence.`
    );
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "product.published",
    entityType: "Product",
    entityId: product.id,
    newValue: { provider, externalId },
  });

  const adminUrl = await resolveExternalAdminUrl(provider, externalId);

  revalidatePath(`/produits/${product.id}`);
  return actionOk({ externalId, adminUrl });
}
