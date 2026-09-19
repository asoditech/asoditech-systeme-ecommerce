"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import {
  createSalesChannelSchema,
  updateSalesChannelSchema,
  setChannelLocationsSchema,
  type CreateSalesChannelInput,
  type UpdateSalesChannelInput,
  type SetChannelLocationsInput,
} from "@/lib/validation/channel";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Business-channel administration — docs/adr/0038-online-offline-unification.md.
 *
 * A SalesChannel is a business activity (Online store, physical Store A…), NOT
 * a location and NOT a quantity. `channels.manage` is an org-structure
 * permission (OWNER/ADMIN only by default), like `warehouses.manage`. Mapping
 * a channel to locations changes where it may sell/fulfil from — it moves and
 * duplicates no stock.
 */

const NAME_TAKEN = "Un canal portant ce nom existe déjà.";

export async function createSalesChannelAction(input: CreateSalesChannelInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("channels.manage");
  const parsed = createSalesChannelSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const warehouseIds = [...new Set(parsed.data.warehouseIds)];
  if (warehouseIds.length > 0) {
    const found = await prisma.warehouse.findMany({ where: { id: { in: warehouseIds }, isActive: true }, select: { id: true } });
    if (found.length !== warehouseIds.length) return actionError("Emplacement introuvable ou inactif.");
  }

  try {
    const channel = await prisma.$transaction(async (tx) => {
      const created = await tx.salesChannel.create({ data: { name: parsed.data.name, kind: parsed.data.kind } });
      if (warehouseIds.length > 0) {
        await tx.salesChannelLocation.createMany({
          data: warehouseIds.map((warehouseId) => ({ salesChannelId: created.id, warehouseId })),
        });
      }
      return created;
    });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "sales_channel.created",
      entityType: "SalesChannel",
      entityId: channel.id,
      newValue: { name: channel.name, kind: channel.kind, warehouseIds },
    });
    revalidatePath("/parametres/canaux");
    return actionOk({ id: channel.id });
  } catch (error) {
    if (isUniqueConstraintError(error)) return actionError(NAME_TAKEN, { name: [NAME_TAKEN] });
    throw error;
  }
}

export async function updateSalesChannelAction(input: UpdateSalesChannelInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("channels.manage");
  const parsed = updateSalesChannelSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const existing = await prisma.salesChannel.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Canal de vente introuvable.");
  // Every delivery order without an explicit choice lands on the default
  // ONLINE channel — it can be renamed but never retired.
  if (existing.isDefault && !parsed.data.isActive) {
    return actionError("Le canal en ligne par défaut ne peut pas être désactivé.");
  }

  try {
    const updated = await prisma.salesChannel.update({
      where: { id: existing.id },
      data: { name: parsed.data.name, isActive: parsed.data.isActive },
    });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "sales_channel.updated",
      entityType: "SalesChannel",
      entityId: updated.id,
      previousValue: { name: existing.name, isActive: existing.isActive },
      newValue: { name: updated.name, isActive: updated.isActive },
    });
    revalidatePath("/parametres/canaux");
    return actionOk({ id: updated.id });
  } catch (error) {
    if (isUniqueConstraintError(error)) return actionError(NAME_TAKEN, { name: [NAME_TAKEN] });
    throw error;
  }
}

/**
 * Replaces the set of locations a channel sells/fulfils from. Only ACTIVE
 * locations may be mapped (a retired location keeps its stock history but no
 * longer takes part in selling).
 */
export async function setChannelLocationsAction(input: SetChannelLocationsInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("channels.manage");
  const parsed = setChannelLocationsSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const channel = await prisma.salesChannel.findUnique({ where: { id: parsed.data.id } });
  if (!channel) return actionError("Canal de vente introuvable.");

  const desired = [...new Set(parsed.data.warehouseIds)];
  if (desired.length > 0) {
    const found = await prisma.warehouse.findMany({ where: { id: { in: desired }, isActive: true }, select: { id: true } });
    if (found.length !== desired.length) return actionError("Emplacement introuvable ou inactif.");
  }

  const existing = await prisma.salesChannelLocation.findMany({ where: { salesChannelId: channel.id } });
  const existingIds = new Set(existing.map((e) => e.warehouseId));
  const toRemove = [...existingIds].filter((id) => !desired.includes(id));
  const toAdd = desired.filter((id) => !existingIds.has(id));

  await prisma.$transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx.salesChannelLocation.deleteMany({ where: { salesChannelId: channel.id, warehouseId: { in: toRemove } } });
    }
    if (toAdd.length > 0) {
      await tx.salesChannelLocation.createMany({
        data: toAdd.map((warehouseId) => ({ salesChannelId: channel.id, warehouseId })),
        skipDuplicates: true,
      });
    }
  });

  if (toRemove.length > 0 || toAdd.length > 0) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "sales_channel.locations_updated",
      entityType: "SalesChannel",
      entityId: channel.id,
      previousValue: { warehouseIds: [...existingIds] },
      newValue: { warehouseIds: desired },
      metadata: {
        note: "Mapping only — no stock moved. The WooCommerce push still feeds active ENTREPOT locations (docs/adr/0038).",
      },
    });
  }
  revalidatePath("/parametres/canaux");
  return actionOk({ id: channel.id });
}
