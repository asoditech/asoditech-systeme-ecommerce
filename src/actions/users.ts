"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { destroyAllSessionsForUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { updateUserStatusSchema, updateUserRoleSchema } from "@/lib/validation/user";
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
