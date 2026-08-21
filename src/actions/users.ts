"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwnerForAction } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessionsForUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { createUserSchema, updateUserStatusSchema, updateUserRoleSchema } from "@/lib/validation/user";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/** Only OWNER may provision accounts or change roles — see docs/adr/0003-auth-and-rbac.md. */
export async function createUserAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const owner = await requireOwnerForAction();

  const parsed = createUserSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    return actionError("Un utilisateur avec cet e-mail existe déjà.", { email: ["E-mail déjà utilisé."] });
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const user = await prisma.user.create({
    data: { name: parsed.data.name, email: parsed.data.email, passwordHash, role: parsed.data.role },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: owner.id,
    action: "user.created",
    entityType: "User",
    entityId: user.id,
    newValue: { email: user.email, role: user.role },
  });

  revalidatePath("/utilisateurs");
  return actionOk({ id: user.id });
}

export async function updateUserStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const owner = await requireOwnerForAction();

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
    actorUserId: owner.id,
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
  const owner = await requireOwnerForAction();

  const parsed = updateUserRoleSchema.safeParse({ id: formData.get("id"), role: formData.get("role") });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.user.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Utilisateur introuvable.");
  if (existing.role === "OWNER") return actionError("Impossible de modifier le rôle du propriétaire.");

  const user = await prisma.user.update({ where: { id: parsed.data.id }, data: { role: parsed.data.role } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: owner.id,
    action: "user.role_changed",
    entityType: "User",
    entityId: user.id,
    previousValue: { role: existing.role },
    newValue: { role: user.role },
  });

  revalidatePath("/utilisateurs");
  return actionOk({ id: user.id });
}
