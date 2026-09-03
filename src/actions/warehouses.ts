"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import {
  createWarehouseSchema,
  updateWarehouseSchema,
  setWarehouseActiveSchema,
} from "@/lib/validation/warehouse";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Warehouse (stock location) CRUD — Phase 32a
 * (docs/adr/0019-inventory-foundation.md). Minimal by design: create,
 * rename/retype, and (de)activate. No delete — a location with inventory
 * history must be kept (`InventoryItem.warehouse` is onDelete: Restrict);
 * deactivate instead.
 *
 * Provider-owned locations (source != INTERNE, e.g. a Shopify Location) are
 * read-only here, mirroring the product-management boundary
 * (docs/adr/0017): they are managed on the platform that owns them.
 */

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function createWarehouseAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("warehouses.manage");

  const parsed = createWarehouseSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type") || "ENTREPOT",
    address: formData.get("address"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const warehouse = await prisma.warehouse.create({
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      address: normalizeOptional(parsed.data.address),
      createdById: user.id,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "warehouse.created",
    entityType: "Warehouse",
    entityId: warehouse.id,
    newValue: { name: warehouse.name, type: warehouse.type },
  });

  revalidatePath("/entrepots");
  revalidatePath("/stock");
  return actionOk({ id: warehouse.id });
}

export async function updateWarehouseAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("warehouses.manage");

  const parsed = updateWarehouseSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    type: formData.get("type") || "ENTREPOT",
    address: formData.get("address"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.warehouse.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Emplacement introuvable.");
  if (existing.source !== "INTERNE") {
    return actionError("Cet emplacement est géré par une intégration externe et ne peut pas être modifié ici.");
  }

  const warehouse = await prisma.warehouse.update({
    where: { id: existing.id },
    data: {
      name: parsed.data.name,
      type: parsed.data.type,
      address: normalizeOptional(parsed.data.address),
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "warehouse.updated",
    entityType: "Warehouse",
    entityId: warehouse.id,
    previousValue: { name: existing.name, type: existing.type, address: existing.address },
    newValue: { name: warehouse.name, type: warehouse.type, address: warehouse.address },
  });

  revalidatePath("/entrepots");
  revalidatePath("/stock");
  return actionOk({ id: warehouse.id });
}

export async function setWarehouseActiveAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("warehouses.manage");

  const parsed = setWarehouseActiveSchema.safeParse({
    id: formData.get("id"),
    isActive: formData.get("isActive"),
  });
  if (!parsed.success) return actionError("Champs invalides.");

  const existing = await prisma.warehouse.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Emplacement introuvable.");
  if (existing.source !== "INTERNE") {
    return actionError("Cet emplacement est géré par une intégration externe et ne peut pas être modifié ici.");
  }
  if (!parsed.data.isActive && existing.isDefault) {
    return actionError("L'emplacement par défaut ne peut pas être désactivé.");
  }
  if (existing.isActive === parsed.data.isActive) {
    return actionOk({ id: existing.id });
  }

  // Deactivating a location does NOT move or recalculate its stock — the
  // InventoryItem rows and their history stay intact; the location simply
  // can no longer receive new stock-in movements (enforced in
  // adjustInventoryAction). Transfers to drain it come in Phase 32b.
  const hadStock = await prisma.inventoryItem.count({
    where: { warehouseId: existing.id, OR: [{ quantityOnHand: { gt: 0 } }, { quantityReserved: { gt: 0 } }] },
  });

  const warehouse = await prisma.warehouse.update({
    where: { id: existing.id },
    data: { isActive: parsed.data.isActive },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: parsed.data.isActive ? "warehouse.activated" : "warehouse.deactivated",
    entityType: "Warehouse",
    entityId: warehouse.id,
    previousValue: { isActive: existing.isActive },
    newValue: { isActive: warehouse.isActive },
    ...(!parsed.data.isActive && hadStock > 0
      ? { metadata: { warning: "location still holds stock", rowsWithStock: hadStock } }
      : {}),
  });

  revalidatePath("/entrepots");
  revalidatePath("/stock");
  return actionOk({ id: warehouse.id });
}
