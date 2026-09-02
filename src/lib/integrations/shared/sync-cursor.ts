import "server-only";
import { prisma } from "@/lib/prisma";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The `since` bound for an incremental orders import (WooCommerce
 * `syncWooCommerceOrdersAction`, Shopify `syncShopifyOrdersAction`).
 *
 * Phase 29 E2E audit fix: this used to read `Integration.lastSyncAt`, but
 * that field is a single, non-resource-scoped timestamp overwritten by
 * *every* successful sync of *any* resource on the integration (products,
 * categories, stock push — see `runSync` in `actions/woocommerce.ts` /
 * `actions/shopify.ts`). Because "Synchroniser les produits" is always run
 * before "Synchroniser les commandes", `lastSyncAt` was already bumped to
 * "now" by the products/categories sync moments earlier — so the orders
 * import window silently collapsed to a few seconds instead of the
 * intended "since the last successful ORDERS sync, or 30 days on a first
 * run", and reported `SUCCES` with 0 items imported no matter how many
 * real orders existed on the store.
 *
 * Fixed by deriving `since` from the last successful (or partially
 * successful — those still imported real orders) `SyncRun` row scoped to
 * `resource: "COMMANDES"` on this integration, instead of the shared
 * `lastSyncAt` field. No schema change needed — `SyncRun` already records
 * this per-resource.
 */
export async function resolveOrdersSyncSince(integrationId: string): Promise<Date> {
  const lastOrdersSync = await prisma.syncRun.findFirst({
    where: { integrationId, resource: "COMMANDES", status: { in: ["SUCCES", "PARTIEL"] } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  return lastOrdersSync?.startedAt ?? new Date(Date.now() - THIRTY_DAYS_MS);
}
