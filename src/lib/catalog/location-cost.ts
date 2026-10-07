import { Prisma } from "@prisma/client";
import type { PrismaTransactionClient } from "@/lib/prisma";

/**
 * Location purchase cost — the ONE rule for "what does a unit cost at this
 * location right now" (never a selling price):
 *
 *   InventoryItem.currentUnitCost (this location)
 *     → ProductVariation.cost
 *       → Product.cost
 *
 * A NULL location cost is exactly today's global-cost behaviour. Readers:
 * new store-sale / ASODITECH-order cost snapshots and stock valuation.
 * Writers (last cost wins — no averaging, no layers, no FIFO): a received
 * transfer line carrying `destinationUnitCost` (src/lib/transfers.ts) and a
 * validated reception while the tenant setting is on (src/lib/receptions.ts).
 * Historical snapshots and movement costs are never rewritten.
 */

type Cost = Prisma.Decimal | number | string | null | undefined;

/** Pure fallback chain — `null` only when no level has a cost. */
export function effectiveUnitCost(
  locationCost: Cost,
  variationCost: Cost,
  productCost: Cost
): Prisma.Decimal | null {
  for (const c of [locationCost, variationCost, productCost]) {
    if (c !== null && c !== undefined) return new Prisma.Decimal(c);
  }
  return null;
}

type Db = Pick<PrismaTransactionClient, "inventoryItem">;

/**
 * The location's own cost for one product/variation (`variationId` wins, as
 * in applyStockMovement) — `null` when the location has no cost or no row.
 */
export async function locationUnitCost(
  db: Db,
  ref: { warehouseId: string; productId?: string | null; variationId?: string | null }
): Promise<Prisma.Decimal | null> {
  if (!ref.variationId && !ref.productId) return null;
  const item = ref.variationId
    ? await db.inventoryItem.findUnique({
        where: { warehouseId_variationId: { warehouseId: ref.warehouseId, variationId: ref.variationId } },
        select: { currentUnitCost: true },
      })
    : await db.inventoryItem.findUnique({
        where: { warehouseId_productId: { warehouseId: ref.warehouseId, productId: ref.productId! } },
        select: { currentUnitCost: true },
      });
  return item?.currentUnitCost ?? null;
}

/** Sets this location row's current purchase cost (last cost wins). */
export async function setLocationUnitCost(db: Db, inventoryItemId: string, cost: Prisma.Decimal | number | string) {
  await db.inventoryItem.update({ where: { id: inventoryItemId }, data: { currentUnitCost: new Prisma.Decimal(cost) } });
}

/** For display: the effective cost and whether it is this location's own or the global fallback. */
export function describeLocationCost(
  locationCost: Cost,
  variationCost: Cost,
  productCost: Cost
): { cost: Prisma.Decimal | null; source: "location" | "global" | null } {
  const cost = effectiveUnitCost(locationCost, variationCost, productCost);
  if (cost === null) return { cost: null, source: null };
  return { cost, source: locationCost !== null && locationCost !== undefined ? "location" : "global" };
}
