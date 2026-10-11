"use server";

import { redirect } from "next/navigation";
import { prisma, prismaBase } from "@/lib/prisma";
import { verifyDummyPassword, verifyPassword } from "@/lib/auth/password";
import { createSession, destroyAllSessionsForUser, destroyCurrentSession, getCurrentUser } from "@/lib/auth/session";
import { requireUserForAction } from "@/lib/auth/guards";
import { clearPlatformUnlock } from "@/lib/auth/platform-access";
import { recordAuditEvent } from "@/lib/audit";
import {
  PROGRESSIVE_LIMITS,
  RATE_LIMITS,
  clearProgressive,
  consumeRateLimit,
  formatRetryAfter,
  getClientIp,
  normalizeEmail,
  rateLimitKey,
  refundRateLimit,
  reserveProgressiveAttempt,
} from "@/lib/security/rate-limit";
import { clearKnownDevice, issueKnownDevice, knownDeviceMatchesUser, readKnownDevice } from "@/lib/security/known-device";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { loginSchema } from "@/lib/validation/auth";
import { actionError, type ActionResult } from "@/actions/types";

// Deliberately vague — never reveal whether the failure was "no such
// account" vs "wrong password" (avoids account enumeration).
const INVALID_CREDENTIALS_MESSAGE = "E-mail ou mot de passe incorrect.";

function tooManyLoginAttempts(decision: { retryAfterMs: number }): string {
  return `Trop de tentatives de connexion. Réessayez dans ${formatRetryAfter(decision.retryAfterMs)}.`;
}

export async function loginAction(
  _prevState: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // Rate limiting (src/lib/security/rate-limit.ts — balanced protection),
  // all of it BEFORE any bcrypt work. The IP bucket counts every attempt and
  // runs first, so one IP cannot mint unlimited email buckets. Then each
  // attempt is RESERVED (counted atomically before the work, so concurrent
  // attempts can't all slip through) in progressive buckets: a few free
  // attempts, then one per growing cooldown, capped at 15 min — never a
  // lockout. A blocked attempt is refused even with the right password (no
  // oracle), and the buckets exist for ANY submitted address, so a refusal
  // reveals nothing about whether an account exists. Fails open: see the
  // module doc.
  const ip = await getClientIp();
  const email = normalizeEmail(parsed.data.email);
  if (ip) {
    const flood = await consumeRateLimit(RATE_LIMITS.loginIp, rateLimitKey(RATE_LIMITS.loginIp, ip), "open");
    if (!flood.allowed && flood.reason === "limited") return actionError(tooManyLoginAttempts(flood));
  }

  // A known device of this address (src/lib/security/known-device.ts) —
  // signature, expiry and address checked from the cookie, then the user it
  // names must still be ACTIVE with the same password. It is exempt from the
  // address-wide bucket (so an attacker hammering the address can't keep its
  // owner out) and held to its own per-device bucket instead — but ONLY for
  // a password check against THAT user. Email is unique per tenant, not
  // globally: a same-address account in another tenant must not lend its
  // device to guesses against this one (see the candidate loop below).
  const device = await readKnownDevice(email);
  const deviceOwner = device
    ? await runUnscoped("auth:login:device", () =>
        prisma.user.findUnique({ where: { id: device.userId }, select: { id: true, email: true, status: true, passwordHash: true } })
      )
    : null;
  const knownDevice =
    device !== null && deviceOwner !== null && normalizeEmail(deviceOwner.email) === email && knownDeviceMatchesUser(device, deviceOwner);

  const emailIpKey = ip ? rateLimitKey(PROGRESSIVE_LIMITS.loginEmailIp, email, ip) : null;
  const emailKey = rateLimitKey(PROGRESSIVE_LIMITS.loginEmail, email);
  const deviceKey = knownDevice ? rateLimitKey(RATE_LIMITS.loginDevice, device.nonce) : null;
  let emailIpCounted = false;
  let emailCounted = false;
  if (emailIpKey) {
    const pair = await reserveProgressiveAttempt(PROGRESSIVE_LIMITS.loginEmailIp, emailIpKey, "open");
    if (!pair.allowed) {
      if (pair.reason === "limited") return actionError(tooManyLoginAttempts(pair));
    } else emailIpCounted = pair.counted;
  }
  const refundPair = async () => {
    if (emailIpKey && emailIpCounted) await refundRateLimit(PROGRESSIVE_LIMITS.loginEmailIp, emailIpKey);
  };
  if (deviceKey) {
    const perDevice = await consumeRateLimit(RATE_LIMITS.loginDevice, deviceKey, "open");
    if (!perDevice.allowed && perDevice.reason === "limited") {
      await refundPair();
      return actionError(tooManyLoginAttempts(perDevice));
    }
  } else {
    const wide = await reserveProgressiveAttempt(PROGRESSIVE_LIMITS.loginEmail, emailKey, "open");
    if (!wide.allowed) {
      if (wide.reason === "limited") {
        await refundPair();
        return actionError(tooManyLoginAttempts(wide));
      }
    } else emailCounted = wide.counted;
  }

  // Login runs before the tenant is known, and email is now unique only
  // PER TENANT (docs/adr/0025, Phase 3) — two tenants may each have a user
  // at this address. Every candidate across every tenant is fetched
  // (unscoped), then disambiguated by password: an ACTIVE candidate whose
  // password actually matches identifies both the user AND their tenant.
  // A failure is audited in each candidate's OWN tenant (see below).
  const candidates = await runUnscoped("auth:login", () =>
    prisma.user.findMany({
      where: { email: parsed.data.email },
      include: { tenant: { select: { status: true } } },
    })
  );

  let user: (typeof candidates)[number] | null = null;
  let passwordChecked = false;
  // A disabled user and a user whose TENANT is suspended (Phase 5 —
  // docs/adr/0027-tenant-provisioning.md) are rejected identically here
  // — same generic message either way, revealing neither.
  const checkable = (c: (typeof candidates)[number]) => c.status === "ACTIVE" && c.tenant.status === "ACTIVE";
  // The known-device exemption covers the device's OWN user only: that one
  // is tried first, under the per-device bucket. Any other candidate (a
  // same-address account in another tenant, or a mistyped password for the
  // owner) is a normal attempt against the address — it is charged to
  // login:email before its password is compared, exactly like an unknown
  // device. Charged whether or not other candidates exist, so the outcome
  // reveals nothing about other accounts.
  const owner = knownDevice ? (candidates.find((c) => c.id === device.userId) ?? null) : null;
  if (owner && checkable(owner)) {
    passwordChecked = true;
    if (await verifyPassword(parsed.data.password, owner.passwordHash)) user = owner;
  }
  if (!user && knownDevice) {
    const wide = await reserveProgressiveAttempt(PROGRESSIVE_LIMITS.loginEmail, emailKey, "open");
    if (!wide.allowed) {
      // The reserved attempts stay counted (the device's, the pair's): the
      // password was compared and did not open the device's own account.
      if (wide.reason === "limited") return actionError(tooManyLoginAttempts(wide));
    } else emailCounted = wide.counted;
  }
  if (!user) {
    for (const candidate of candidates) {
      if (candidate === owner || !checkable(candidate)) continue;
      passwordChecked = true;
      if (await verifyPassword(parsed.data.password, candidate.passwordHash)) {
        user = candidate;
        break;
      }
    }
  }
  // N1: no real hash was compared (unknown email, or only disabled/suspended
  // accounts) — burn one comparison anyway so this path is not measurably
  // faster than a wrong password.
  if (!passwordChecked) await verifyDummyPassword(parsed.data.password);

  if (!user) {
    // The reserved attempts stay counted: that IS the failure record.
    // R1 (docs/adr/0053): a failure is recorded ONLY in the tenant(s) that
    // actually own an account with this email — each sees only its own user,
    // never another customer's attempt. An email that matches no account
    // belongs to no tenant: it is never written to any customer's journal
    // (it used to land in the bootstrap tenant's), only to the server log,
    // without the email itself.
    for (const candidate of candidates) {
      await runWithTenant(candidate.tenantId, "auth:login:failure", () =>
        recordAuditEvent({
          actorType: "SYSTEM",
          action: "user.login.failure",
          entityType: "User",
          entityId: candidate.id,
          metadata: { email: candidate.email },
        })
      );
    }
    if (candidates.length === 0) console.warn("[auth] login failure for an unknown account (not attributable to any tenant)");
    return actionError(INVALID_CREDENTIALS_MESSAGE);
  }

  // Password verified — the rest runs pinned to this user's own tenant.
  await runWithTenant(user.tenantId, "auth:login", async () => {
    await createSession(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "user.login.success",
      entityType: "User",
      entityId: user.id,
    });
  });
  // Only this email+IP pair is forgiven. login:email only gets THIS
  // attempt back: one valid login must not reset a distributed attack's
  // counter. This browser becomes (or stays, rotated) a known device.
  if (emailIpKey) await clearProgressive(PROGRESSIVE_LIMITS.loginEmailIp, emailIpKey);
  if (emailCounted) await refundRateLimit(PROGRESSIVE_LIMITS.loginEmail, emailKey);
  if (deviceKey) await refundRateLimit(RATE_LIMITS.loginDevice, deviceKey);
  await issueKnownDevice(user, email);

  redirect("/tableau-de-bord");
}

export async function logoutAction(): Promise<void> {
  const user = await getCurrentUser();
  if (user) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "user.logout",
      entityType: "User",
      entityId: user.id,
    });
  }
  await destroyCurrentSession();
  redirect("/connexion");
}

/**
 * « Se déconnecter de toutes les sessions » — ends EVERY session of the
 * current user, this one included, through the same session infrastructure
 * as a password reset (`destroyAllSessionsForUser`). Only ever the caller's
 * own sessions: tenant-wide revocation stays the platform's suspend action.
 * Audited first, pinned to the user's tenant while the session still
 * resolves; every other device is signed out on its next request because
 * each request re-verifies the session row.
 */
export async function logoutAllSessionsAction(): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  await runWithTenant(user.tenantId, "auth:logout-all", async () => {
    const revokedSessions = await prismaBase.session.count({ where: { userId: user.id } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "user.sessions_revoked_all",
      entityType: "User",
      entityId: user.id,
      metadata: { revokedSessions },
    });
    await destroyAllSessionsForUser(user.id);
  });
  await clearPlatformUnlock();
  // This device stops being a « known device » too (see known-device.ts for
  // why other devices keep theirs until expiry or a password change).
  await clearKnownDevice();
  await destroyCurrentSession();
  redirect("/connexion");
}
