"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { loadShopifyClient } from "@/lib/integrations/shopify/client-loader";
import { isShopifyIntegrationEnabled, SHOPIFY_DISABLED_MESSAGE } from "@/lib/integrations/shopify/feature-flag";
import { checkWooCommerceProduct } from "@/lib/integrations/woocommerce/remote-deletion";
import { checkShopifyProduct } from "@/lib/integrations/shopify/remote-deletion";
import {
  applyRemoteProductCheck,
  clearRemoteMissingLink,
  pendingRemoteMissingOf,
  remoteLinkOfProduct,
  unlinkRemoteProduct,
  type RemoteDeletionResult,
  type RemoteProductCheck,
  type RemoteProductLink,
} from "@/lib/integrations/shared/remote-deletion";
import { changeRemoteListing, loadListingAdapter, reconcileRemoteListing } from "@/lib/integrations/shared/remote-listing";
import type { RemoteListing } from "@/lib/integrations/shared/remote-listing-state";
import { PROVIDER_LABEL, remoteIdLabel } from "@/lib/integrations/shared/remote-product-labels";
import { remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * Product page actions for a product linked to a connected store
 * (src/lib/integrations/shared/remote-deletion.ts — inbound: the store
 * deleted it; src/lib/integrations/shared/remote-listing.ts — outbound:
 * « Retirer de la boutique » / « Remettre en vente »). Same permissions as
 * publishing a product (products.edit + integrations.manage): the link being
 * changed is the one publishing creates. Tenant-scoped through `prisma`; a
 * product of another company is simply « introuvable » / « non lié ».
 */

const providerSchema = z.enum(["WOOCOMMERCE", "SHOPIFY"]);
const linkInputSchema = z.object({ productId: z.string().min(1).max(64), provider: providerSchema.default("WOOCOMMERCE") });
const listingInputSchema = linkInputSchema.extend({ op: z.enum(["withdraw", "republish"]) });

type Provider = z.infer<typeof providerSchema>;

async function requireLinkManager() {
  const user = await requirePermissionForAction("products.edit");
  if (!userHasPermission(user, "integrations.manage")) {
    return { user, error: "Vous n'avez pas la permission de gérer le lien de ce produit avec la boutique." } as const;
  }
  return { user, error: null } as const;
}

/** The connection's checker + config, or null (not configured / invalid stored address). */
async function loadChecker(provider: Provider): Promise<{ config: unknown; check: (externalId: string) => Promise<RemoteProductCheck> } | null> {
  try {
    if (provider === "WOOCOMMERCE") {
      const loaded = await loadWooCommerceClient();
      return loaded ? { config: loaded.integration.config, check: (id) => checkWooCommerceProduct(loaded.client, id) } : null;
    }
    const loaded = await loadShopifyClient();
    return loaded ? { config: loaded.integration.config, check: (id) => checkShopifyProduct(loaded.client, id) } : null;
  } catch {
    return null; // invalid stored store URL — treated as « not reachable »
  }
}

function revalidateProduct(productId: string) {
  revalidatePath(`/produits/${productId}`);
  revalidatePath("/produits");
  revalidatePath("/produits/exporter");
}

const notLinked = (provider: Provider) => `Ce produit n'est pas lié à ${PROVIDER_LABEL[provider]}.`;

/**
 * « Vérifier sur la boutique »: asks the store about this product now and
 * applies the company's rule (applyRemoteProductCheck). A store that cannot
 * be reached changes nothing here.
 */
export async function checkRemoteProductAction(
  input: unknown
): Promise<ActionResult<{ check: RemoteProductCheck; result: RemoteDeletionResult }>> {
  const { user, error } = await requireLinkManager();
  if (error) return actionError(error);
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");
  const { provider, productId } = parsed.data;
  if (provider === "SHOPIFY" && !isShopifyIntegrationEnabled()) return actionError(SHOPIFY_DISABLED_MESSAGE);

  const link = await remoteLinkOfProduct(provider, productId);
  if (!link) return actionError(notLinked(provider));
  const loaded = await loadChecker(provider);
  if (!loaded) return actionError(`Connexion ${PROVIDER_LABEL[provider]} non configurée ou identifiants incomplets.`);

  const check = await loaded.check(link.externalId);
  const result = await applyRemoteProductCheck(link, check, {
    mode: remoteDeletionModeOf(loaded.config),
    trigger: "check",
    actor: { type: "USER", userId: user.id },
    flagWhenUnknown: false,
  });
  revalidateProduct(link.productId);
  return actionOk({ check, result });
}

/**
 * « Dissocier de la boutique », confirmed by an authorised user. The store is
 * asked once more first: a product it still has is never unlinked. When the
 * store cannot be reached, unlinking is allowed only for a product the
 * store's own deletion webhook already flagged.
 */
export async function unlinkRemoteProductAction(input: unknown): Promise<ActionResult<{ unlinked: true }>> {
  const { user, error } = await requireLinkManager();
  if (error) return actionError(error);
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");
  const { provider, productId } = parsed.data;
  if (provider === "SHOPIFY" && !isShopifyIntegrationEnabled()) return actionError(SHOPIFY_DISABLED_MESSAGE);
  const label = PROVIDER_LABEL[provider];

  const link = await remoteLinkOfProduct(provider, productId);
  if (!link) return actionError(`Ce produit n'est déjà plus lié à ${label}.`);
  const actor = { type: "USER", userId: user.id } as const;

  const loaded = await loadChecker(provider);
  const check: RemoteProductCheck = loaded ? await loaded.check(link.externalId) : "unknown";
  if (check === "exists") {
    await clearRemoteMissingLink(link, actor);
    revalidateProduct(link.productId);
    return actionError(`Ce produit existe toujours sur la boutique ${label} (${remoteIdLabel(provider, link.externalId)}) : il reste lié.`);
  }
  if (check === "unknown" && !(await pendingRemoteMissingOf(link))) {
    return actionError(`Impossible de vérifier ce produit sur la boutique ${label} pour le moment — réessayez plus tard.`);
  }

  const unlinked = await unlinkRemoteProduct(link, { mode: "manual", check, reason: "user_confirmed", actor });
  if (!unlinked) return actionError(`Ce produit n'est déjà plus lié à ${label}.`);
  revalidateProduct(link.productId);
  return actionOk({ unlinked: true });
}

/** WooCommerce-named entry points (kept for the existing callers and tests). */
export async function checkWooCommerceRemoteProductAction(input: unknown) {
  return checkRemoteProductAction({ ...(input as object), provider: "WOOCOMMERCE" });
}
export async function unlinkWooCommerceProductAction(input: unknown) {
  return unlinkRemoteProductAction({ ...(input as object), provider: "WOOCOMMERCE" });
}

/**
 * Outbound: only a link ASODITECH itself created or claimed on the store
 * (a ProductPublication row for that remote id). A product created on the
 * store and merely imported stays the store's to withdraw.
 */
async function publishedLink(provider: Provider, productId: string): Promise<RemoteProductLink | string> {
  const link = await remoteLinkOfProduct(provider, productId);
  if (!link) return notLinked(provider);
  const publication = await prisma.productPublication.findFirst({ where: { productId, provider, externalId: link.externalId }, select: { id: true } });
  if (!publication) {
    return `Ce produit a été créé sur la boutique ${PROVIDER_LABEL[provider]} : retirez-le ou remettez-le en vente depuis l'administration de la boutique.`;
  }
  return link;
}

/**
 * « Retirer de la boutique » (`withdraw`: WooCommerce draft / Shopify
 * ARCHIVED) or « Remettre en vente » (`republish`: publish / ACTIVE) —
 * soft and reversible only, explicitly confirmed in the UI, never a
 * permanent deletion. See remote-listing.ts for the read-first,
 * single-attempt, « à vérifier » rules.
 */
export async function changeRemoteListingAction(
  input: unknown
): Promise<ActionResult<{ outcome: "changed" | "already"; listing: RemoteListing }>> {
  const { user, error } = await requireLinkManager();
  if (error) return actionError(error);
  const parsed = listingInputSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");
  const { provider, productId, op } = parsed.data;
  if (provider === "SHOPIFY" && !isShopifyIntegrationEnabled()) return actionError(SHOPIFY_DISABLED_MESSAGE);

  const link = await publishedLink(provider, productId);
  if (typeof link === "string") return actionError(link);
  const adapter = await loadListingAdapter(provider);
  if (!adapter) return actionError(`Connexion ${PROVIDER_LABEL[provider]} non configurée ou identifiants incomplets.`);

  const result = await changeRemoteListing(link, op, user.id, adapter);
  revalidateProduct(productId);
  if (!result.ok) return actionError(result.message);
  return actionOk({ outcome: result.outcome, listing: result.listing });
}

/** « Vérifier l'état sur la boutique »: re-reads the store; resolves an « à vérifier » request. Never sends a change. */
export async function reconcileRemoteListingAction(input: unknown): Promise<ActionResult<{ listing: RemoteListing; resolved: boolean }>> {
  const { user, error } = await requireLinkManager();
  if (error) return actionError(error);
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");
  const { provider, productId } = parsed.data;
  if (provider === "SHOPIFY" && !isShopifyIntegrationEnabled()) return actionError(SHOPIFY_DISABLED_MESSAGE);

  const link = await publishedLink(provider, productId);
  if (typeof link === "string") return actionError(link);
  const adapter = await loadListingAdapter(provider);
  if (!adapter) return actionError(`Connexion ${PROVIDER_LABEL[provider]} non configurée ou identifiants incomplets.`);

  const result = await reconcileRemoteListing(link, user.id, adapter);
  revalidateProduct(productId);
  if (!result.ok) return actionError(result.message);
  return actionOk({ listing: result.listing, resolved: result.resolved });
}
