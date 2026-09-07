"use server";

import { redirect } from "next/navigation";
import { prisma, prismaBase } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import { findUsablePasswordResetToken } from "@/lib/auth/token-lookup";
import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessionsForUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { sendPasswordResetEmail } from "@/lib/email";
import { requestPasswordResetSchema, resetPasswordSchema } from "@/lib/validation/auth";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { PrismaTransactionClient } from "@/lib/prisma";

/**
 * Phase 5 (docs/adr/0027-tenant-provisioning.md) — password reset via the
 * SAME secure one-time-token mechanism as invitations
 * (src/lib/auth/tokens.ts): a random 256-bit token, only its hash stored,
 * expiring, single-use.
 *
 * The self-service request path emails the reset link (src/lib/email.ts
 * — falls back to logging it when no email provider is configured) and
 * always returns a generic response to the browser, so an unauthenticated
 * caller can never learn whether a given email has an account. The
 * admin-initiated path (`adminResetPasswordAction`) instead hands the
 * link straight back to the tenant admin who requested it — they're
 * already authorized to manage that user, so there's no enumeration risk
 * to guard against, and no email is sent for that path.
 */

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — shorter-lived than an invitation
const GENERIC_INVALID_TOKEN = "Ce lien de réinitialisation n'est plus valide.";

async function issueResetToken(tx: PrismaTransactionClient, userId: string): Promise<string> {
  const rawToken = generateRawToken();
  await tx.passwordResetToken.create({
    data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  return rawToken;
}

/** Public — no session. Never reveals whether the email matched an
 * account, in which tenant, or how many. */
export async function requestPasswordResetAction(
  _prevState: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const parsed = requestPasswordResetSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return actionError("Adresse e-mail invalide.");
  }

  // Unscoped: email is unique per tenant, not globally (docs/adr/0025) —
  // the same address can match an ACTIVE user in more than one tenant.
  const candidates = await runUnscoped("password-reset:request", () =>
    prismaBase.user.findMany({
      where: { email: parsed.data.email, status: "ACTIVE" },
      include: { tenant: { select: { status: true } } },
    })
  );

  for (const candidate of candidates) {
    if (candidate.tenant.status !== "ACTIVE") continue;
    await runWithTenant(candidate.tenantId, "password-reset:request", async () => {
      const rawToken = await issueResetToken(prisma, candidate.id);
      // Never returned to the browser — see the module doc comment.
      await sendPasswordResetEmail({ to: candidate.email, resetUrl: `/reinitialiser-mot-de-passe/${rawToken}` });
      await recordAuditEvent({
        actorType: "SYSTEM",
        action: "password_reset.requested",
        entityType: "User",
        entityId: candidate.id,
      });
    });
  }

  return actionOk(undefined);
}

/** Public — no session. Single-use, expiring. */
export async function resetPasswordAction(
  _prevState: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const parsed = resetPasswordSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const found = await findUsablePasswordResetToken(parsed.data.token);
  if (!found) {
    return actionError(GENERIC_INVALID_TOKEN);
  }
  const { resetToken, usable } = found;
  if (!usable) {
    await runWithTenant(resetToken.tenantId, "password-reset:complete", () =>
      recordAuditEvent({
        actorType: "SYSTEM",
        action: "password_reset.invalid_use_attempt",
        entityType: "PasswordResetToken",
        entityId: resetToken.id,
      })
    );
    return actionError(GENERIC_INVALID_TOKEN);
  }

  await runWithTenant(resetToken.tenantId, "password-reset:complete", async () => {
    await prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash: await hashPassword(parsed.data.password) },
    });
    await prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } });
    await destroyAllSessionsForUser(resetToken.userId);
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: resetToken.userId,
      action: "password_reset.completed",
      entityType: "User",
      entityId: resetToken.userId,
    });
  });

  redirect("/connexion");
}

/**
 * Admin-initiated — a tenant admin (`users.manage`) generates a reset link
 * for a user IN THEIR OWN TENANT (scoped automatically) and gets the raw
 * link back directly, to relay out-of-band. No enumeration risk: the
 * caller already has legitimate access to this user's account. Never for
 * an OWNER account — an ADMIN minting themselves a reset link for the
 * OWNER and using it would be a straight privilege escalation around the
 * same guard updateUserStatusAction/updateUserRoleAction enforce.
 */
export async function adminResetPasswordAction(formData: FormData): Promise<ActionResult<{ resetUrl: string }>> {
  const actor = await requirePermissionForAction("users.manage");
  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId) return actionError("Utilisateur invalide.");

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) return actionError("Utilisateur introuvable.");
  if (target.status !== "ACTIVE") return actionError("Ce compte est désactivé.");
  // Same "OWNER accounts are immutable to everyone else" invariant as
  // updateUserStatusAction/updateUserRoleAction (src/actions/users.ts) —
  // without this, an ADMIN could mint themselves a reset link for the
  // OWNER account and take it over, an escalation those two guards exist
  // specifically to prevent.
  if (target.role === "OWNER") return actionError("Impossible de réinitialiser le mot de passe du propriétaire.");

  const rawToken = await issueResetToken(prisma, target.id);

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "password_reset.requested",
    entityType: "User",
    entityId: target.id,
    metadata: { via: "admin" },
  });

  return actionOk({ resetUrl: `/reinitialiser-mot-de-passe/${rawToken}` });
}
