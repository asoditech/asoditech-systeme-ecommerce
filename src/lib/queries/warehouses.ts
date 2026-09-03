import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Warehouses an operator may pick as an order's fulfilment location
 * (Phase 32b). Every active warehouse is offered — an active MAGASIN is a
 * legitimate choice for a walk-in / internal order — with the default
 * warehouse first so the form can pre-select it. A single-warehouse
 * deployment returns one row and the order form renders no selector.
 */
export async function listSelectableFulfilmentWarehouses() {
  return prisma.warehouse.findMany({
    where: { isActive: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: { id: true, name: true, type: true, isDefault: true },
  });
}
