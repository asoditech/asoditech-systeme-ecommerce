import "server-only";

import type { SalesChannel, Warehouse } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * Business channels — docs/adr/0038-online-offline-unification.md.
 *
 * A SalesChannel is a business ACTIVITY (where a product may be sold, which
 * transactions belong to which business). It is NOT a place and NEVER a
 * quantity: physical stock stays on InventoryItem, per Warehouse. Nothing
 * in this module reads or writes a stock quantity.
 */

type Db = typeof prisma | PrismaTransactionClient;

export const DEFAULT_ONLINE_CHANNEL_NAME = "En ligne";

/**
 * The locations the ONLINE storefront stock push already feeds today:
 * active ENTREPOTs (WooCommerce — ADR 0020 §9) and Shopify-source Locations
 * (Shopify pushes per Location). MAGASIN locations never fed it.
 *
 * The default ONLINE channel is seeded/auto-mapped with exactly this set so
 * "channel stock" for Online reads the same locations the push already uses.
 * The push itself is NOT rewritten in this increment — it keeps its own
 * type-based rule (docs/adr/0038 §"What is deliberately unchanged").
 */
export function isStorefrontFeedingLocation(w: Pick<Warehouse, "type" | "isActive" | "source">): boolean {
  return w.isActive && (w.type === "ENTREPOT" || w.source === "SHOPIFY");
}

/**
 * The tenant's default ONLINE channel id, creating it (and mapping the
 * storefront-feeding locations) when it does not exist yet.
 *
 * Self-healing on purpose: the migration seeds one per existing tenant and
 * `provisionTenantBaseline` creates one for a new tenant, but a restore of a
 * pre-channels backup replaces the channel table with an empty one, so every
 * order-creation path must be able to recover rather than fail. Idempotent
 * and race-safe: a concurrent creator loses on the per-tenant unique
 * indexes and simply re-reads the winner.
 */
export async function ensureDefaultOnlineChannel(db: Db = prisma): Promise<SalesChannel> {
  const existing = await db.salesChannel.findFirst({ where: { isDefault: true } });
  if (existing) return existing;

  try {
    const created = await db.salesChannel.create({
      data: { name: DEFAULT_ONLINE_CHANNEL_NAME, kind: "ONLINE", isDefault: true },
    });
    const warehouses = await db.warehouse.findMany({
      where: { isActive: true, OR: [{ type: "ENTREPOT" }, { source: "SHOPIFY" }] },
      select: { id: true },
    });
    if (warehouses.length > 0) {
      await db.salesChannelLocation.createMany({
        data: warehouses.map((w) => ({ salesChannelId: created.id, warehouseId: w.id })),
        skipDuplicates: true,
      });
    }
    return created;
  } catch (error) {
    // Lost the race (default-per-tenant or name-per-tenant unique index):
    // the winner's row is there now.
    if (isUniqueConstraintError(error)) {
      const winner = await db.salesChannel.findFirst({ where: { isDefault: true } });
      if (winner) return winner;
    }
    throw error;
  }
}

/** Shorthand used at every order-creation site. */
export async function getDefaultOnlineChannelId(db: Db = prisma): Promise<string> {
  return (await ensureDefaultOnlineChannel(db)).id;
}

/**
 * A NEW ENTREPOT is automatically mapped to the default ONLINE channel, so
 * the channel mapping keeps mirroring what the (unchanged, type-based)
 * WooCommerce push actually feeds. Later edits to a location's type/active
 * flag are NOT re-synced — from then on the mapping is explicit channel
 * configuration (`/parametres/canaux`).
 */
export async function mapNewLocationToDefaultOnline(
  db: Db,
  warehouse: Pick<Warehouse, "id" | "type" | "isActive" | "source">
): Promise<void> {
  if (!isStorefrontFeedingLocation(warehouse)) return;
  const channel = await ensureDefaultOnlineChannel(db);
  await db.salesChannelLocation.createMany({
    data: [{ salesChannelId: channel.id, warehouseId: warehouse.id }],
    skipDuplicates: true,
  });
}

/**
 * Makes a product available on the default ONLINE channel. Best-effort and
 * silent — called from the WooCommerce/Shopify product import paths, where a
 * failure here must never fail (or roll back) a sync.
 */
export async function enableProductOnDefaultOnlineChannel(productId: string): Promise<void> {
  try {
    const channel = await ensureDefaultOnlineChannel();
    await prisma.productSalesChannel.createMany({
      data: [{ productId, salesChannelId: channel.id }],
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("enableProductOnDefaultOnlineChannel() failed (non-fatal):", error);
  }
}

/**
 * Whether a product may be sold on a channel. A variation inherits its
 * product's availability. This is availability ONLY — it says nothing about
 * stock; use the inventory primitives for that.
 */
export async function isProductAvailableOnChannel(
  db: Db,
  productId: string,
  salesChannelId: string
): Promise<boolean> {
  const row = await db.productSalesChannel.findUnique({
    where: { productId_salesChannelId: { productId, salesChannelId } },
    select: { id: true },
  });
  return row !== null;
}

/** The active warehouse ids a channel sells/fulfils from. Derived, never stored quantities. */
export async function listChannelWarehouseIds(db: Db, salesChannelId: string): Promise<string[]> {
  const rows = await db.salesChannelLocation.findMany({
    where: { salesChannelId, warehouse: { isActive: true } },
    select: { warehouseId: true },
  });
  return rows.map((r) => r.warehouseId);
}
