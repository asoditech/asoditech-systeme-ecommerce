"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import {
  applyRemoteCheck,
  checkWooCommerceProduct,
  clearRemoteMissing,
  pendingRemoteMissing,
  unlinkWooProduct,
  wooLinkOfProduct,
  type RemoteDeletionResult,
  type RemoteProductCheck,
} from "@/lib/integrations/woocommerce/remote-deletion";
import { remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * Product page actions for a product whose WooCommerce counterpart may have
 * been deleted (src/lib/integrations/woocommerce/remote-deletion.ts). Same
 * permissions as publishing a product (products.edit + integrations.manage):
 * the link being changed is the one publishing creates. Tenant-scoped through
 * `prisma`; a product of another company is simply « introuvable ».
 */

const inputSchema = z.object({ productId: z.string().min(1).max(64) });

async function requireLinkManager() {
  const user = await requirePermissionForAction("products.edit");
  if (!userHasPermission(user, "integrations.manage")) {
    return { user, error: "Vous n'avez pas la permission de gérer le lien de ce produit avec la boutique." } as const;
  }
  return { user, error: null } as const;
}

async function loadClient() {
  try {
    return await loadWooCommerceClient();
  } catch {
    return null; // invalid stored store URL — treated as « not reachable »
  }
}

function revalidateProduct(productId: string) {
  revalidatePath(`/produits/${productId}`);
  revalidatePath("/produits");
  revalidatePath("/produits/exporter");
}

/**
 * « Vérifier sur la boutique »: asks the store about this product now and
 * applies the company's rule (applyRemoteCheck). A store that cannot be
 * reached changes nothing here.
 */
export async function checkWooCommerceRemoteProductAction(
  input: unknown
): Promise<ActionResult<{ check: RemoteProductCheck; result: RemoteDeletionResult }>> {
  const { user, error } = await requireLinkManager();
  if (error) return actionError(error);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const link = await wooLinkOfProduct(parsed.data.productId);
  if (!link) return actionError("Ce produit n'est pas lié à WooCommerce.");
  const loaded = await loadClient();
  if (!loaded) return actionError("Connexion WooCommerce non configurée ou identifiants incomplets.");

  const check = await checkWooCommerceProduct(loaded.client, link.externalId);
  const result = await applyRemoteCheck(link, check, {
    mode: remoteDeletionModeOf(loaded.integration.config),
    trigger: "check",
    actor: { type: "USER", userId: user.id },
    flagWhenUnknown: false,
  });
  revalidateProduct(link.productId);
  return actionOk({ check, result });
}

/**
 * « Dissocier de WooCommerce », confirmed by an authorised user. The store is
 * asked once more first: a product it still has is never unlinked. When the
 * store cannot be reached, unlinking is allowed only for a product the
 * store's own deletion webhook already flagged.
 */
export async function unlinkWooCommerceProductAction(input: unknown): Promise<ActionResult<{ unlinked: true }>> {
  const { user, error } = await requireLinkManager();
  if (error) return actionError(error);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.");

  const link = await wooLinkOfProduct(parsed.data.productId);
  if (!link) return actionError("Ce produit n'est déjà plus lié à WooCommerce.");
  const actor = { type: "USER", userId: user.id } as const;

  const loaded = await loadClient();
  const check = await checkWooCommerceProduct(loaded?.client ?? null, link.externalId);
  if (check === "exists") {
    await clearRemoteMissing(link, actor);
    revalidateProduct(link.productId);
    return actionError(`Ce produit existe toujours sur la boutique WooCommerce (#${link.externalId}) : il reste lié.`);
  }
  if (check === "unknown" && !(await pendingRemoteMissing(link))) {
    return actionError("Impossible de vérifier ce produit sur la boutique WooCommerce pour le moment — réessayez plus tard.");
  }

  const unlinked = await unlinkWooProduct(link, { mode: "manual", check, reason: "user_confirmed", actor });
  if (!unlinked) return actionError("Ce produit n'est déjà plus lié à WooCommerce.");
  revalidateProduct(link.productId);
  return actionOk({ unlinked: true });
}
