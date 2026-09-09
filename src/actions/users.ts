"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { destroyAllSessionsForUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { updateUserStatusSchema, updateUserRoleSchema, deleteUserSchema } from "@/lib/validation/user";
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
