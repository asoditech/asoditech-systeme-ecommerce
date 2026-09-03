import "server-only";
import { prisma } from "@/lib/prisma";
import type { RecordSource } from "@prisma/client";

// Once a source has any imported order, later syncs use a rolling window
// rather than re-scanning the whole history each click. Kept deliberately
// wide (~18 months) so that even a first import that timed out partway
// still has its older pages picked up by the next run. The first sync for
// a source has no floor at all — a just-connected store brings its whole
// history in, bounded only by MAX_PAGES in each provider's client.
const INCREMENTAL_WINDOW_MS = 550 * 24 * 60 * 60 * 1000;

/**
 * The `since` bound for an incremental orders import (WooCommerce
 * `syncWooCommerceOrdersAction`, Shopify `syncShopifyOrdersAction`).
 *
 * Derived from whether we already hold any order from this source, NOT
 * from a SyncRun / `lastSyncAt` timestamp. Earlier revisions keyed off a
 * wall-clock sync timestamp and compared it against order *creation*
 * dates — so a store whose most recent order predated the first sync run
 * imported 0 orders yet reported SUCCES, and once that empty run existed
 * the cursor stayed stuck at "now" and every later run also imported 0.
 * Keying off "do we hold any order from this source yet" removes that
 * whole failure mode: the first run is unbounded, later runs use a
 * rolling window that always contains any newly placed order.
 *
 * `undefined` means "no lower bound" — the provider client then lists the
 * full order history (still capped by its own MAX_PAGES).
 */
export async function resolveOrdersSyncSince(source: RecordSource): Promise<Date | undefined> {
  const alreadyImported = await prisma.order.count({ where: { source } });
  return alreadyImported > 0 ? new Date(Date.now() - INCREMENTAL_WINDOW_MS) : undefined;
}
