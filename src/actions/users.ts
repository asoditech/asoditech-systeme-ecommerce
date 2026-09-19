"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { destroyAllSessionsForUser } from "@/lib/auth/session";
import { hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { recordAuditEvent } from "@/lib/audit";
import {
  updateUserStatusSchema,
  updateUserRoleSchema,
  deleteUserSchema,
  setUserLocationsSchema,
  setUserPermissionOverridesSchema,
  setUserChannelsSchema,
  type SetUserLocationsInput,
  type SetUserPermissionOverridesInput,
  type SetUserChannelsInput,
} from "@/lib/validation/user";
import { isGlobalRole } from "@/lib/auth/effective-access";
import { requireCapabilityForAction } from "@/lib/auth/capabilities";
import { isPermission, type Permission } from "@/lib/auth/permissions";
import { permissionAvailable } from "@/lib/tenant/business-mode";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * OWNER and ADMIN may manage users — WITHIN THEIR OWN TENANT (the Phase
 * 2-4 extension + RLS scope every query here automatically; nothing in
 * this file ever needs an explicit tenantId check). See
 * docs/adr/0003-auth-and-rbac.md and docs/adr/0027-tenant-provisioning.md.
 * Creating an account is now `inviteUserAction` (src/actions/invitations.ts)
 * — there is no more "admin picks a temporary password" path.
 */

export async function updateUserStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("users.manage");

  const parsed = updateUserStatusSchema.safeParse({ id: formData.get("id"), status: formData.get("status") });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.user.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Utilisateur introuvable.");
  if (existing.role === "OWNER") return actionError("Impossible de désactiver le compte propriétaire.");

  const user = await prisma.user.update({ where: { id: parsed.data.id }, data: { status: parsed.data.status } });
  if (parsed.data.status === "DISABLED") {
    await destroyAllSessionsForUser(user.id);
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "user.status_changed",
    entityType: "User",
    entityId: user.id,
    previousValue: { status: existing.status },
    newValue: { status: user.status },
  });

  revalidatePath("/utilisateurs");
  return actionOk({ id: user.id });
}

/**
 * Permanently deletes a user account AND its own dependent rows (sessions,
 * password-reset tokens, notifications, and — only if it carries no
 * financial history — its commission-agent profile), via the DB cascades
 * declared on those relations.
 *
 * Business records the user merely *touched* are preserved: every
 * "created by / performed by / actor" foreign key to `users` is
 * `onDelete: SetNull` in the schema, so orders, products, customers,
 * expenses, stock movements, audit events, etc. all survive with their
 * actor attribution cleared. Deleting a user never deletes a single order
 * or product.
 *
 * Refused when:
 *  - the target is the OWNER (immutable), or is the actor themselves;
 *  - the user is a commission agent that already has ledger entries or a
 *    closed monthly statement (those relations are `onDelete: Restrict` —
 *    the financial history must stay). Deactivating is the right move
 *    there, and the error says so.
 */
export async function deleteUserAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("users.manage");

  const parsed = deleteUserSchema.safeParse({
    id: formData.get("id"),
    confirmEmail: formData.get("confirmEmail"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.user.findUnique({
    where: { id: parsed.data.id },
    include: {
      commissionAgent: {
        include: { _count: { select: { entries: true, statements: true } } },
      },
    },
  });
  if (!existing) return actionError("Utilisateur introuvable.");
  if (existing.id === actor.id) return actionError("Vous ne pouvez pas supprimer votre propre compte.");
  if (existing.role === "OWNER") return actionError("Impossible de supprimer le compte propriétaire.");
  if (existing.email.toLowerCase() !== parsed.data.confirmEmail.toLowerCase()) {
    return actionError("La confirmation ne correspond pas à l'e-mail du compte.");
  }

  const agent = existing.commissionAgent;
  if (agent && (agent._count.entries > 0 || agent._count.statements > 0)) {
    return actionError(
      "Cet utilisateur est un agent avec un historique de commissions — il ne peut pas être supprimé. Désactivez plutôt son compte."
    );
  }

  await destroyAllSessionsForUser(existing.id);

  // Audit BEFORE the delete — once the row is gone `actorUserId` on new
  // events can't reference it, and we want the snapshot of who was removed.
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "user.deleted",
    entityType: "User",
    entityId: existing.id,
    previousValue: {
      name: existing.name,
      email: existing.email,
      role: existing.role,
      status: existing.status,
    },
  });

  // Ledger provenance (docs/adr/0038): `InventoryMovement.performedById` is
  // `onDelete: SetNull`, so deleting the user would erase WHO moved stock.
  // Snapshot their name onto every movement they performed first — the FK
  // still goes null (unchanged), but the ledger keeps the human. Only rows
  // that don't already carry a snapshot are touched.
  await prisma.inventoryMovement.updateMany({
    where: { performedById: existing.id, performedByName: null },
    data: { performedByName: existing.name },
  });

  await prisma.user.delete({ where: { id: existing.id } });

  revalidatePath("/utilisateurs");
  revalidatePath("/journal-audit");
  return actionOk({ id: existing.id });
}

export async function updateUserRoleAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("users.manage");

  const parsed = updateUserRoleSchema.safeParse({ id: formData.get("id"), role: formData.get("role") });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }
  // Only OWNER may hand out the OWNER role — an ADMIN could otherwise
  // promote a user to OWNER and lose the "OWNER accounts are immutable to
  // everyone else" guarantee below at one remove.
  if (parsed.data.role === "OWNER" && actor.role !== "OWNER") {
    return actionError("Seul le propriétaire peut attribuer le rôle propriétaire.");
  }

  const existing = await prisma.user.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Utilisateur introuvable.");
  if (existing.role === "OWNER") return actionError("Impossible de modifier le rôle du propriétaire.");

  const user = await prisma.user.update({ where: { id: parsed.data.id }, data: { role: parsed.data.role } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "user.role_changed",
    entityType: "User",
    entityId: user.id,
    previousValue: { role: existing.role },
    newValue: { role: user.role },
  });

  revalidatePath("/utilisateurs");
  return actionOk({ id: user.id });
}

/**
 * Location Access Management v1 (docs/adr/0037-location-access-management.md).
 * Replaces a user's ENTIRE set of warehouse assignments with the submitted
 * one (a diff — rows removed from the set are deleted, new ones created —
 * not an append). `users.manage`-gated, same as every other action in this
 * file; OWNER/ADMIN never need this (they bypass UserLocation entirely —
 * see hasGlobalLocationAccess), so assigning them is a documented no-op
 * rather than a silent one.
 *
 * Every submitted id is validated against the tenant-scoped `prisma`
 * client — an id belonging to another tenant, or that doesn't exist,
 * simply isn't found and is silently dropped from the accepted set,
 * closing the "assign a user to a foreign tenant's warehouse" path
 * structurally (the same mechanism every other cross-tenant id check in
 * this codebase relies on — docs/adr/0024).
 */
export async function setUserLocationsAction(
  input: SetUserLocationsInput
): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("users.manage");

  const parsed = setUserLocationsSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target) return actionError("Utilisateur introuvable.");
  if (hasGlobalLocationAccess(target.role)) {
    return actionError(
      "Ce rôle a déjà accès à tous les emplacements du tenant — l'attribution d'emplacements n'a aucun effet."
    );
  }

  // Tenant-scoped by construction — a foreign or non-existent id is simply
  // absent from `validWarehouses` and dropped below.
  const validWarehouses = await prisma.warehouse.findMany({
    where: { id: { in: parsed.data.warehouseIds } },
    select: { id: true },
  });
  const desiredIds = new Set(validWarehouses.map((w) => w.id));

  const existing = await prisma.userLocation.findMany({
    where: { userId: target.id },
    select: { warehouseId: true },
  });
  const existingIds = new Set(existing.map((e) => e.warehouseId));

  const toRemove = [...existingIds].filter((id) => !desiredIds.has(id));
  const toAdd = [...desiredIds].filter((id) => !existingIds.has(id));

  await prisma.$transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx.userLocation.deleteMany({ where: { userId: target.id, warehouseId: { in: toRemove } } });
    }
    if (toAdd.length > 0) {
      await tx.userLocation.createMany({
        data: toAdd.map((warehouseId) => ({ userId: target.id, warehouseId, createdById: actor.id })),
      });
    }
  });

  if (toRemove.length > 0 || toAdd.length > 0) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: "user.locations_updated",
      entityType: "User",
      entityId: target.id,
      previousValue: { warehouseIds: [...existingIds] },
      newValue: { warehouseIds: [...desiredIds] },
    });
  }

  revalidatePath("/utilisateurs");
  return actionOk({ id: target.id });
}

/**
 * Permissions no per-user override may touch (docs/adr/0039). `users.manage`
 * is what lets someone edit these very overrides — granting it to a
 * non-admin would let them grant themselves everything, i.e. silently mint an
 * admin. It stays reserved to the OWNER/ADMIN roles.
 */
const NON_OVERRIDABLE_PERMISSIONS = new Set(["users.manage"]);

/**
 * Replaces a user's ENTIRE set of GRANT/DENY overrides with the submitted one
 * (a diff — not an append). `users.manage`-gated. The role matrix is
 * untouched: this records only how ONE user differs from their role
 * (docs/adr/0039).
 *
 *   effective = (role ∪ grants) − denies        DENY always wins
 *
 * OWNER/ADMIN are refused (they hold everything and cannot be narrowed —
 * lock-out protection). Unknown permission strings are rejected outright, and
 * a permission cannot be both granted and denied in one submission.
 */
export async function setUserPermissionOverridesAction(
  input: SetUserPermissionOverridesInput
): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("users.manage");

  const parsed = setUserPermissionOverridesSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target) return actionError("Utilisateur introuvable.");
  if (isGlobalRole(target.role)) {
    return actionError("Ce rôle dispose déjà de toutes les permissions — un ajustement individuel n'a aucun effet.");
  }

  const grants = [...new Set(parsed.data.grants)];
  const denies = [...new Set(parsed.data.denies)];
  const all = [...grants, ...denies];
  if (all.some((p) => !isPermission(p))) return actionError("Permission inconnue.");
  // A permission whose capability the tenant's business mode does not enable is
  // inert (docs/adr/0041) — refuse to store an override for it.
  if (all.some((p) => !permissionAvailable(p as Permission, actor.capabilities))) {
    return actionError("Cette permission n'est pas disponible dans le mode d'activité de votre espace.");
  }
  if (all.some((p) => NON_OVERRIDABLE_PERMISSIONS.has(p))) {
    return actionError("Cette permission est réservée aux rôles propriétaire et administrateur.");
  }
  if (grants.some((p) => denies.includes(p))) {
    return actionError("Une permission ne peut pas être à la fois accordée et refusée.");
  }

  const existing = await prisma.userPermissionOverride.findMany({ where: { userId: target.id } });
  const desired = new Map<string, "GRANT" | "DENY">([
    ...grants.map((p) => [p, "GRANT"] as const),
    ...denies.map((p) => [p, "DENY"] as const),
  ]);
  const existingByPerm = new Map(existing.map((o) => [o.permission, o]));

  const toDelete = existing.filter((o) => !desired.has(o.permission)).map((o) => o.id);
  const toUpsert = [...desired].filter(([perm, effect]) => existingByPerm.get(perm)?.effect !== effect);

  await prisma.$transaction(async (tx) => {
    if (toDelete.length > 0) await tx.userPermissionOverride.deleteMany({ where: { id: { in: toDelete } } });
    for (const [permission, effect] of toUpsert) {
      await tx.userPermissionOverride.upsert({
        where: { userId_permission: { userId: target.id, permission } },
        update: { effect, createdById: actor.id },
        create: { userId: target.id, permission, effect, createdById: actor.id },
      });
    }
  });

  if (toDelete.length > 0 || toUpsert.length > 0) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: "user.permissions_updated",
      entityType: "User",
      entityId: target.id,
      previousValue: {
        grants: existing.filter((o) => o.effect === "GRANT").map((o) => o.permission),
        denies: existing.filter((o) => o.effect === "DENY").map((o) => o.permission),
      },
      newValue: { grants, denies },
    });
  }

  // The affected user's next request resolves the new effective set (it is
  // computed per request from these rows — nothing cached across requests).
  revalidatePath("/utilisateurs");
  return actionOk({ id: target.id });
}

/**
 * Replaces a user's ENTIRE set of business-channel assignments (docs/adr/0039)
 * — the channel counterpart of `setUserLocationsAction`, with the same
 * semantics: OWNER/ADMIN need none (refused as a no-op), zero channels means
 * zero access, and a foreign / unknown id simply isn't found (tenant-scoped
 * client) and is dropped.
 */
export async function setUserChannelsAction(input: SetUserChannelsInput): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("users.manage");
  // No channel scope exists in an ONLINE_ONLY tenant (docs/adr/0041).
  requireCapabilityForAction(actor, "storeChannels");

  const parsed = setUserChannelsSchema.safeParse(input);
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
  if (!target) return actionError("Utilisateur introuvable.");
  if (isGlobalRole(target.role)) {
    return actionError("Ce rôle a déjà accès à tous les canaux — l'attribution de canaux n'a aucun effet.");
  }

  const validChannels = await prisma.salesChannel.findMany({
    where: { id: { in: parsed.data.salesChannelIds }, isActive: true },
    select: { id: true },
  });
  const desiredIds = new Set(validChannels.map((c) => c.id));

  const existing = await prisma.userChannel.findMany({ where: { userId: target.id }, select: { salesChannelId: true } });
  const existingIds = new Set(existing.map((e) => e.salesChannelId));
  const toRemove = [...existingIds].filter((id) => !desiredIds.has(id));
  const toAdd = [...desiredIds].filter((id) => !existingIds.has(id));

  await prisma.$transaction(async (tx) => {
    if (toRemove.length > 0) {
      await tx.userChannel.deleteMany({ where: { userId: target.id, salesChannelId: { in: toRemove } } });
    }
    if (toAdd.length > 0) {
      await tx.userChannel.createMany({
        data: toAdd.map((salesChannelId) => ({ userId: target.id, salesChannelId, createdById: actor.id })),
      });
    }
  });

  if (toRemove.length > 0 || toAdd.length > 0) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: "user.channels_updated",
      entityType: "User",
      entityId: target.id,
      previousValue: { salesChannelIds: [...existingIds] },
      newValue: { salesChannelIds: [...desiredIds] },
    });
  }

  revalidatePath("/utilisateurs");
  return actionOk({ id: target.id });
}
