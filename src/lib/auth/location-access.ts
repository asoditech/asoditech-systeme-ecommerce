import "server-only";

import type { UserRole, WarehouseType } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Location Access Management v1 (docs/adr/0037-location-access-management.md).
 *
 * Warehouse is the ONLY physical-location entity (docs/adr/0019) — this
 * module is purely the authorization layer on top of it: which of the
 * acting tenant's warehouses a given user may operate on. It does not
 * touch inventory accounting, order/transfer/stocktake semantics, or
 * tenant isolation — all of that is unchanged (docs/adr/0024-0026,
 * 0036-inventory-single-source-of-truth.md).
 *
 * Either the shared client or an open transaction client — same pattern as
 * src/lib/inventory.ts. Both are tenant-scoped by the Prisma extension
 * (docs/adr/0024), so a call here never needs its own explicit tenantId
 * filter.
 */
type Db = typeof prisma | PrismaTransactionClient;

/**
 * OWNER and ADMIN bypass UserLocation entirely and get every active
 * warehouse in their own tenant — never a database lookup, never a row to
 * maintain. Every other role's access is defined ENTIRELY by UserLocation:
 * zero rows means zero warehouses (safe default-deny — see
 * requireLocationAccessForAction below).
 */
export function hasGlobalLocationAccess(role: UserRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/**
 * The real security boundary for a warehouse-scoped Server Action —
 * call this AFTER the action has already resolved the target `Warehouse`
 * row itself (existence + isActive, exactly as every warehouse-touching
 * action already does today — see src/actions/inventory.ts,
 * src/actions/transfers.ts, src/actions/stocktakes.ts,
 * src/actions/orders.ts). Because that prior lookup already goes through
 * the tenant-scoped `prisma` client, a forged id belonging to another
 * tenant is already impossible to reach this function with (it would have
 * failed the caller's own "introuvable" check first) — this function's
 * only job is the INTRA-tenant question: is THIS warehouse in THIS user's
 * assigned set.
 *
 * A single indexed existence check on the (userId, warehouseId) unique
 * index — cheap, no list ever loaded, safe to call once per warehouse per
 * action (e.g. twice for a transfer's source + destination).
 *
 * Throws a generic, detail-free error (matching requirePermissionForAction's
 * own convention) rather than returning a result — every caller already
 * expects a Server Action guard to throw.
 */
export async function requireLocationAccessForAction(
  user: Pick<CurrentUser, "id" | "role">,
  warehouseId: string,
  db: Db = prisma
): Promise<void> {
  if (hasGlobalLocationAccess(user.role)) return;

  const assignment = await db.userLocation.findUnique({
    where: { userId_warehouseId: { userId: user.id, warehouseId } },
    select: { id: true },
  });
  if (!assignment) {
    throw new Error("Non autorisé : accès à cet emplacement non attribué.");
  }
}

export interface SelectableWarehouse {
  id: string;
  name: string;
  type: WarehouseType;
  isDefault: boolean;
}

/**
 * Active warehouses this user may pick from — the authorized replacement
 * for "every active warehouse" (the pre-v1 behaviour, still exactly what
 * OWNER/ADMIN get). Used to filter pickers (order form, transfer form,
 * stocktake form, stock report) server-side, not just in the UI — the
 * actual submitted id is still re-validated by
 * requireLocationAccessForAction on every mutation.
 *
 * One query, never N+1: a scoped user's assignments are joined straight to
 * `warehouses` in a single `findMany`, ordered exactly like the pre-v1
 * `listSelectableFulfilmentWarehouses` (default first, then name) so the
 * picker's default-selection logic needs no change.
 */
export async function listAccessibleActiveWarehouses(
  user: Pick<CurrentUser, "id" | "role">,
  db: Db = prisma
): Promise<SelectableWarehouse[]> {
  if (hasGlobalLocationAccess(user.role)) {
    return db.warehouse.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, isDefault: true },
    });
  }

  const assignments = await db.userLocation.findMany({
    where: { userId: user.id, warehouse: { isActive: true } },
    orderBy: [{ warehouse: { isDefault: "desc" } }, { warehouse: { name: "asc" } }],
    select: { warehouse: { select: { id: true, name: true, type: true, isDefault: true } } },
  });
  return assignments.map((a) => a.warehouse);
}

/**
 * The fulfilment warehouse to use when an order is created with NO
 * explicit override (docs/adr/0020's `getDefaultWarehouseId()` path).
 *
 * OWNER/ADMIN: unchanged — the tenant's single default warehouse, exactly
 * as before this feature existed.
 *
 * Every other user: the tenant default is used ONLY if it's in their own
 * authorized set (the common case — see the migration's backfill). If
 * they have exactly one authorized active warehouse, that one is used
 * (mirrors the order form's own "hide the picker when there's only one
 * choice" behaviour, now scoped to the user instead of the tenant). If
 * they have several and none is the tenant default, the first of their
 * own authorized set is used — still always a warehouse they may
 * operate on. `null` means "no authorized warehouse at all" — the caller
 * (createOrderAction) must reject the order rather than silently
 * resolving to something the user cannot access.
 */
export async function resolveAuthorizedDefaultWarehouseId(
  user: Pick<CurrentUser, "id" | "role">,
  db: Db = prisma
): Promise<string | null> {
  if (hasGlobalLocationAccess(user.role)) {
    const w = await db.warehouse.findFirst({ where: { isDefault: true }, select: { id: true } });
    return w?.id ?? null;
  }

  const warehouses = await listAccessibleActiveWarehouses(user, db);
  if (warehouses.length === 0) return null;
  return (warehouses.find((w) => w.isDefault) ?? warehouses[0]).id;
}
