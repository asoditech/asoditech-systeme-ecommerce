"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { runWithTenant } from "@/lib/tenant/context";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import { findUsableInvitation } from "@/lib/auth/token-lookup";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { inviteUserSchema } from "@/lib/validation/user";
import { acceptInvitationSchema } from "@/lib/validation/auth";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

// Phase 5 (docs/adr/0027-tenant-provisioning.md) — tenant-scoped user
// provisioning by invitation, replacing the old "OWNER picks a temporary
// password" flow entirely. `inviteUserAction`/`revokeInvitationAction` run
// inside the inviter's own tenant (`requirePermissionForAction` + the
// Phase 2-4 extension/RLS scope every query to it automatically — no
// explicit tenantId check needed anywhere in this file).

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GENERIC_INVALID_INVITATION = "Cette invitation n'est plus valide.";

/**
 * Invite an email to join the caller's own tenant at a given role. Only
 * OWNER may invite another OWNER — the same privilege-escalation guard
 * `updateUserRoleAction` already enforces for role changes.
 */
export async function inviteUserAction(formData: FormData): Promise<ActionResult<IdResult & { inviteUrl: string }>> {
  const actor = await requirePermissionForAction("users.manage");

  const parsed = inviteUserSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }
  if (parsed.data.role === "OWNER" && actor.role !== "OWNER") {
    return actionError("Seul le propriétaire peut inviter un autre propriétaire.");
  }

  const existingUser = await prisma.user.findFirst({ where: { email: parsed.data.email } });
  if (existingUser) {
    return actionError("Un utilisateur avec cet e-mail existe déjà.", { email: ["E-mail déjà utilisé."] });
  }

  // At most one live invitation per (tenant, email) — revoke any prior
  // pending one rather than leaving two valid tokens outstanding.
  await prisma.invitation.updateMany({
    where: { email: parsed.data.email, status: "PENDING" },
    data: { status: "REVOKED" },
  });

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  let invitation;
  try {
    invitation = await prisma.invitation.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name,
        role: parsed.data.role,
        tokenHash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById: actor.id,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // tokenHash collision — astronomically unlikely (256-bit random);
      // treat as a transient failure the caller can retry.
      return actionError("Une erreur est survenue, veuillez réessayer.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "invitation.created",
    entityType: "Invitation",
    entityId: invitation.id,
    newValue: { email: invitation.email, role: invitation.role },
  });

  revalidatePath("/utilisateurs");
  return actionOk({ id: invitation.id, inviteUrl: `/invitations/${rawToken}` });
}

export async function revokeInvitationAction(formData: FormData): Promise<ActionResult<undefined>> {
  const actor = await requirePermissionForAction("users.manage");
  const id = formData.get("id");
  if (typeof id !== "string" || !id) return actionError("Invitation invalide.");

  const existing = await prisma.invitation.findUnique({ where: { id } });
  if (!existing) return actionError("Invitation introuvable.");
  if (existing.status !== "PENDING") return actionError("Cette invitation n'est plus en attente.");

  await prisma.invitation.update({ where: { id }, data: { status: "REVOKED" } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "invitation.revoked",
    entityType: "Invitation",
    entityId: existing.id,
    metadata: { email: existing.email },
  });

  revalidatePath("/utilisateurs");
  return actionOk(undefined);
}

/**
 * Public — no session. Looked up by the token's hash across every tenant
 * (`runUnscoped`, exactly like login's email lookup — the tenant isn't
 * known until the token resolves one), then the User row is created
 * pinned to the invitation's own tenant (`runWithTenant`).
 */
export async function acceptInvitationAction(
  _prevState: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const parsed = acceptInvitationSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const found = await findUsableInvitation(parsed.data.token);
  if (!found) {
    return actionError(GENERIC_INVALID_INVITATION);
  }
  const { invitation, usable } = found;
  if (!usable) {
    await runWithTenant(invitation.tenantId, "invitation:accept", () =>
      recordAuditEvent({
        actorType: "SYSTEM",
        action: "invitation.expired_or_invalid_use_attempt",
        entityType: "Invitation",
        entityId: invitation.id,
        metadata: { status: invitation.status },
      })
    );
    return actionError(GENERIC_INVALID_INVITATION);
  }

  const user = await runWithTenant(invitation.tenantId, "invitation:accept", async () => {
    // Race guard: another request could have accepted a DIFFERENT
    // invitation for this same email in the tiny window since the check
    // above (composite unique also backstops this at the DB level).
    const already = await prisma.user.findFirst({ where: { email: invitation.email } });
    if (already) return null;

    const created = await prisma.user.create({
      data: {
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        passwordHash: await hashPassword(parsed.data.password),
        status: "ACTIVE",
      },
    });

    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: created.id },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: created.id,
      action: "invitation.accepted",
      entityType: "Invitation",
      entityId: invitation.id,
      newValue: { userId: created.id },
    });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: created.id,
      action: "user.created",
      entityType: "User",
      entityId: created.id,
      newValue: { email: created.email, role: created.role },
      metadata: { via: "invitation", invitationId: invitation.id },
    });

    return created;
  });

  if (!user) {
    return actionError("Un compte existe déjà pour cette adresse e-mail.");
  }

  await createSession(user.id);
  redirect("/tableau-de-bord");
}
