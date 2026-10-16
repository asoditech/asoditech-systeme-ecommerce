/**
 * Pure, client-safe labels for the remote product lifecycle (no Prisma, no
 * network) — shared by the inbound rule (remote-deletion.ts), the outbound
 * « Retirer de la boutique » (remote-listing.ts) and the product page.
 */

export type RemoteProvider = "WOOCOMMERCE" | "SHOPIFY";

export const PROVIDER_LABEL: Record<RemoteProvider, string> = { WOOCOMMERCE: "WooCommerce", SHOPIFY: "Shopify" };

/** « #123 » — a Shopify gid (gid://shopify/Product/123) is shown by its numeric tail only. */
export function remoteIdLabel(provider: RemoteProvider, externalId: string): string {
  if (provider === "SHOPIFY") {
    const tail = externalId.split("/").pop();
    return `#${tail && tail.length > 0 ? tail : externalId}`;
  }
  return `#${externalId}`;
}

/**
 * What each store lets ASODITECH do to a remote product, and what happens
 * locally — the single source of the product page's explanation (and of the
 * report's semantics table). Official API semantics:
 * - WooCommerce REST v3: `DELETE /products/{id}` moves to the trash
 *   (`force=false`, default) or deletes permanently (`force=true`); a
 *   product `status` is draft | pending | private | publish.
 * - Shopify Admin GraphQL 2026-07: `productDelete` is irreversible;
 *   `productUpdate(product: { status })` sets ACTIVE | ARCHIVED | DRAFT
 *   (| UNLISTED since 2025-10).
 */
export interface RemoteOperationSupport {
  /** The one remote operation ASODITECH sends for « Retirer de la boutique ». */
  withdraw: { label: string; remoteStatus: string; reversible: true };
  /** « Remettre en vente ». */
  republish: { label: string; remoteStatus: string };
  /** Never sent by ASODITECH. */
  permanentDeletion: string;
  /** How the store's own deletion is detected (inbound). */
  inboundDeletion: string;
  /** What the store's own withdrawal does locally on the next sync. */
  localEffect: string;
}

export const REMOTE_OPERATION_SUPPORT: Record<RemoteProvider, RemoteOperationSupport> = {
  WOOCOMMERCE: {
    withdraw: { label: "Mise en brouillon", remoteStatus: "draft", reversible: true },
    republish: { label: "Publication", remoteStatus: "publish" },
    permanentDeletion:
      "Jamais envoyée par ASODITECH (ni corbeille ni suppression définitive) : à faire, si vous le souhaitez, depuis l'administration WooCommerce.",
    inboundDeletion:
      "Suppression confirmée seulement si WooCommerce répond « produit inexistant » ; une mise à la corbeille reste réversible et demande votre confirmation.",
    localEffect: "Le statut local passera à « Brouillon » à la prochaine synchronisation ; le produit, son stock et son historique sont conservés.",
  },
  SHOPIFY: {
    withdraw: { label: "Archivage", remoteStatus: "ARCHIVED", reversible: true },
    republish: { label: "Réactivation", remoteStatus: "ACTIVE" },
    permanentDeletion:
      "Jamais envoyée par ASODITECH (productDelete est irréversible chez Shopify) : à faire, si vous le souhaitez, depuis l'administration Shopify.",
    inboundDeletion:
      "Suppression confirmée seulement si Shopify ne renvoie plus le produit ; un produit archivé ou en brouillon sur Shopify est désactivé ici, jamais dissocié.",
    localEffect:
      "Le produit sera archivé ici à la prochaine synchronisation, puis réactivé automatiquement quand Shopify le remettra en vente ; son stock et son historique sont conservés.",
  },
};
