"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { prisma, prismaBase } from "@/lib/prisma";
import { requirePermissionForAction, requirePlatformAdminForAction } from "@/lib/auth/guards";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import { findUsablePasswordResetToken } from "@/lib/auth/token-lookup";
import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessionsForUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { sendPasswordResetEmail } from "@/lib/email";
import {
  PROGRESSIVE_LIMITS,
  RATE_LIMITS,
  clearProgressive,
  consumeRateLimit,
  getClientIp,
  normalizeEmail,
  rateLimitKey,
} from "@/lib/security/rate-limit";
import { knownDeviceMatchesUser, readKnownDevice } from "@/lib/security/known-device";
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
const TOO_MANY_RESET_REQUESTS = "Trop de demandes de réinitialisation. Réessayez plus tard.";
const TOO_MANY_RESET_ATTEMPTS = "Trop de tentatives. Réessayez plus tard.";

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

  // Rate limiting (src/lib/security/rate-limit.ts), before any lookup —
  // separate from every login bucket. The IP limit may say so: it is about
  // the caller, not about any account. The EMAIL limits (keyed on any
  // submitted address, account or not; hourly AND daily) are absorbed
  // silently — the usual generic success, no email sent — so they can
  // neither reveal an account nor be used to flood an inbox. A known device
  // of the address (src/lib/security/known-device.ts) uses its own quota
  // instead: an attacker exhausting the address's quota can't silently make
  // the owner's own recovery unusable. That exemption covers the device's
  // OWN user only, and only while that user is still ACTIVE with the same
  // password (knownDeviceMatchesUser) — email is unique per tenant, so a
  // same-address account in another tenant (or a disabled one) must not
  // lend its device to requests for this address: every other account is
  // served only within the address's normal quota, which the device's
  // requests are charged to as well.
  const ip = await getClientIp();
  if (ip) {
    const flood = await consumeRateLimit(RATE_LIMITS.resetRequestIp, rateLimitKey(RATE_LIMITS.resetRequestIp, ip), "open");
    if (!flood.allowed && flood.reason === "limited") return actionError(TOO_MANY_RESET_REQUESTS);
  }
  const email = normalizeEmail(parsed.data.email);
  const device = await readKnownDevice(email);
  const deviceOwner = device
    ? await runUnscoped("password-reset:request:device", () =>
        prismaBase.user.findUnique({ where: { id: device.userId }, select: { id: true, email: true, status: true, passwordHash: true } })
      )
    : null;
  const deviceOwnerId =
    device !== null && deviceOwner !== null && normalizeEmail(deviceOwner.email) === email && knownDeviceMatchesUser(device, deviceOwner)
      ? deviceOwner.id
      : null;
  const addressQuotaAllows = async () => {
    const perEmail = await consumeRateLimit(RATE_LIMITS.resetRequestEmail, rateLimitKey(RATE_LIMITS.resetRequestEmail, email), "open");
    if (!perEmail.allowed) return false;
    const perEmailDaily = await consumeRateLimit(
      RATE_LIMITS.resetRequestEmailDaily,
      rateLimitKey(RATE_LIMITS.resetRequestEmailDaily, email),
      "open"
    );
    return perEmailDaily.allowed;
  };
  let othersAllowed: boolean;
  if (device && deviceOwnerId) {
    const perDevice = await consumeRateLimit(RATE_LIMITS.resetRequestDevice, rateLimitKey(RATE_LIMITS.resetRequestDevice, device.nonce), "open");
    if (!perDevice.allowed) return actionOk(undefined);
    othersAllowed = await addressQuotaAllows();
  } else {
    if (!(await addressQuotaAllows())) return actionOk(undefined);
    othersAllowed = true;
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
    if (candidate.id !== deviceOwnerId && !othersAllowed) continue; // beyond the address quota: silently absorbed
    await runWithTenant(candidate.tenantId, "password-reset:request", async () => {
      const rawToken = await issueResetToken(prisma, candidate.id);
      // Never returned to the browser — see the module doc comment.
      // N2: the slow part (the provider call) runs after the response via
      // `after()` — on Vercel the invocation is kept alive (waitUntil) until
      // it settles — so an existing account no longer answers measurably
      // slower than an unknown one. The token and the audit row are still
      // written before responding; sendEmail is already best-effort.
      const to = candidate.email;
      after(() =>
        sendPasswordResetEmail({ to, resetUrl: `/reinitialiser-mot-de-passe/${rawToken}` }).catch(() => {
          console.error("[email] password reset email delivery failed");
        })
      );
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

  // Flood control (Batch 1A): the 256-bit token is not guessable, but each
  // attempt costs a lookup (and bcrypt on success).
  const ip = await getClientIp();
  if (ip) {
    const flood = await consumeRateLimit(RATE_LIMITS.resetConfirmIp, rateLimitKey(RATE_LIMITS.resetConfirmIp, ip), "open");
    if (!flood.allowed && flood.reason === "limited") return actionError(TOO_MANY_RESET_ATTEMPTS);
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

  const passwordHash = await hashPassword(parsed.data.password);
  const completed = await runWithTenant(resetToken.tenantId, "password-reset:complete", async () => {
    // One transaction: claim this token (conditionally — a concurrent use of
    // the same link loses here instead of resetting twice), set the
    // password, and (N3) retire every OTHER still-usable link of this user,
    // so an older reset email can no longer be used afterwards. Already-used
    // and expired tokens are left exactly as they are.
    const done = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: resetToken.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: resetToken.userId }, data: { passwordHash } });
      await tx.passwordResetToken.updateMany({
        where: { userId: resetToken.userId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      await recordAuditEvent(
        {
          actorType: "USER",
          actorUserId: resetToken.userId,
          action: "password_reset.completed",
          entityType: "User",
          entityId: resetToken.userId,
        },
        tx
      );
      return true;
    });
    if (done) await destroyAllSessionsForUser(resetToken.userId);
    return done;
  });
  if (!completed) return actionError(GENERIC_INVALID_TOKEN);

  // The owner of the address just proved control of it: lift the cooldowns
  // an attacker may have caused on this address — everywhere, and for this
  // address + IP. The new password also revokes every known device of the
  // user (their stamp no longer matches — src/lib/security/known-device.ts).
  const resetEmail = normalizeEmail(resetToken.user.email);
  await clearProgressive(PROGRESSIVE_LIMITS.loginEmail, rateLimitKey(PROGRESSIVE_LIMITS.loginEmail, resetEmail));
  if (ip) await clearProgressive(PROGRESSIVE_LIMITS.loginEmailIp, rateLimitKey(PROGRESSIVE_LIMITS.loginEmailIp, resetEmail, ip));

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

/**
 * Platform owner: force a customer user to choose a new password
 * (docs/adr/0053). Never reveals or sets a known password: the current hash
 * is replaced by the hash of a random secret nobody holds, every session is
 * ended, and the user receives the standard single-use, 1-hour reset link.
 * Platform admin accounts are refused (they manage their own credentials).
 */
export async function forcePasswordResetAction(formData: FormData): Promise<ActionResult<undefined>> {
  await requirePlatformAdminForAction();
  const userId = formData.get("userId");
  if (typeof userId !== "string" || !userId) return actionError("Utilisateur invalide.");

  const target = await runUnscoped("platform:force-password-reset", () =>
    prismaBase.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true, email: true, status: true, isPlatformAdmin: true } })
  );
  if (!target) return actionError("Utilisateur introuvable.");
  if (target.isPlatformAdmin) return actionError("Impossible pour un compte administrateur de la plateforme.");
  if (target.status !== "ACTIVE") return actionError("Ce compte est désactivé.");

  await runWithTenant(target.tenantId, "platform:force-password-reset", async () => {
    await prisma.user.update({ where: { id: target.id }, data: { passwordHash: await hashPassword(generateRawToken()) } });
    await destroyAllSessionsForUser(target.id);
    const rawToken = await issueResetToken(prisma, target.id);
    await sendPasswordResetEmail({ to: target.email, resetUrl: `/reinitialiser-mot-de-passe/${rawToken}` });
    await recordAuditEvent({
      actorType: "SYSTEM",
      action: "user.password_reset_forced",
      entityType: "User",
      entityId: target.id,
      metadata: { by: "platform" },
    });
  });
  return actionOk(undefined);
}
