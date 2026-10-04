import "server-only";

import { userHasPermission } from "@/lib/auth/permissions";
import { hasCapability } from "@/lib/auth/capabilities";
import { traceabilitySearchHref } from "@/lib/traceability-scan";
import type { CurrentUser } from "@/lib/auth/session";

/** A follow-up action on a product result (« Recevoir du stock », …). */
export interface QuickSearchAction {
  kind: "open" | "trace" | "label" | "receive";
  label: string;
  href: string;
}

/**
 * Product actions offered in the command palette, filtered by the SAME
 * permission/capability each target page enforces on the server (a hidden
 * action is a convenience; the page guard is the authority):
 *  - fiche          → products.view (already required to get the result);
 *  - traçabilité    → traceability.view (/tracabilite);
 *  - étiquette      → products.edit + catalogIdentity (/produits/[id]/etiquette),
 *                     simple products only — a variable product prints one
 *                     label per variation from its Identité tab;
 *  - recevoir stock → purchases.create: a plain link to the ordinary
 *                     /receptions/nouveau page — nothing pre-selected, nothing
 *                     written; stock moves only when a reception is validated.
 * No "Transférer" action: stock transfers have no pre-selection workflow yet.
 */
export function productQuickActions(
  user: Pick<CurrentUser, "permissions" | "capabilities">,
  product: { id: string; sku: string; variationCount: number }
): QuickSearchAction[] {
  const actions: QuickSearchAction[] = [{ kind: "open", label: "Ouvrir la fiche", href: `/produits/${product.id}` }];
  const traceHref = traceabilitySearchHref(product.sku);
  if (traceHref && userHasPermission(user, "traceability.view")) {
    actions.push({ kind: "trace", label: "Voir la traçabilité", href: traceHref });
  }
  if (product.variationCount === 0 && userHasPermission(user, "products.edit") && hasCapability(user, "catalogIdentity")) {
    actions.push({ kind: "label", label: "Imprimer l'étiquette", href: `/produits/${product.id}/etiquette` });
  }
  if (userHasPermission(user, "purchases.create")) {
    actions.push({ kind: "receive", label: "Recevoir du stock", href: "/receptions/nouveau" });
  }
  return actions;
}
