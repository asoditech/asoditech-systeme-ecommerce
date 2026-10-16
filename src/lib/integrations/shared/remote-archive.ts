/**
 * Pure rule (no Prisma) behind `remoteArchiveIsRestorable`
 * (src/lib/integrations/shared/remote-deletion.ts): may an archive be lifted
 * because the store proves the product is live again?
 */

/** Why the store (never a user) archived a product locally. */
export type RemoteArchiveReason = "deleted_upstream" | "archived_upstream";
const RESTORABLE_REASONS: readonly string[] = ["deleted_upstream", "archived_upstream"] satisfies RemoteArchiveReason[];

/**
 * `event` = the product's LATEST `product.archived` audit event. Restorable
 * only when the integration of THIS store recorded it for a store-side
 * reason; a user's archive (any actor USER), another store's, a legacy
 * archive without an event, or an unknown reason → never.
 */
export function isRestorableArchiveEvent(
  event: { actorType: string; metadata: unknown } | null,
  provider: "WOOCOMMERCE" | "SHOPIFY"
): boolean {
  if (!event || event.actorType !== "INTEGRATION") return false;
  const meta = (event.metadata ?? {}) as { source?: unknown; reason?: unknown };
  return meta.source === provider && typeof meta.reason === "string" && RESTORABLE_REASONS.includes(meta.reason);
}
