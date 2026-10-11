"use server";

import { redirect } from "next/navigation";
import { requireUserForAction } from "@/lib/auth/guards";
import { clearPlatformUnlock, issuePlatformUnlock, platformKeyConfigured, verifyPlatformKey } from "@/lib/auth/platform-access";
import { recordAuditEvent } from "@/lib/audit";
import {
  RATE_LIMITS,
  consumeRateLimit,
  rateLimitKey,
  refundRateLimit,
  retryAfterMinutes,
  type RateLimitDecision,
} from "@/lib/security/rate-limit";
import { actionError, type ActionResult } from "@/actions/types";

/**
 * Platform step-up unlock (docs/adr/0053). Only a platform admin may try;
 * the key itself is never logged or stored — the audit event records only
 * success / failure, in the admin's own tenant.
 */
export async function unlockPlatformAction(
  _prev: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  if (!user.isPlatformAdmin) return actionError("Non autorisé : réservé aux administrateurs de la plateforme.");
  if (!platformKeyConfigured()) {
    return actionError("L'accès plateforme n'est pas configuré sur ce déploiement (PLATFORM_ACCESS_KEY_SHA256).");
  }

  // Attempt limits (src/lib/security/rate-limit.ts), BEFORE the key is even
  // compared. Every attempt is counted atomically up front (so concurrent
  // attempts can't all pass a read-then-check) and a success gives its
  // count back — the buckets end up counting failures. Fails CLOSED: if the
  // limiter can't count this attempt (read OR write fault), no attempt is
  // made at all. The verification itself (constant-time, verifyPlatformKey)
  // is unchanged.
  const buckets = [
    [RATE_LIMITS.unlockUser, rateLimitKey(RATE_LIMITS.unlockUser, user.id)],
    [RATE_LIMITS.unlockUserDaily, rateLimitKey(RATE_LIMITS.unlockUserDaily, user.id)],
  ] as const;
  const counted: (typeof buckets)[number][] = [];
  let refusal: Exclude<RateLimitDecision, { allowed: true }> | null = null;
  for (const entry of buckets) {
    const decision = await consumeRateLimit(entry[0], entry[1], "closed");
    if (!decision.allowed) {
      refusal = decision;
      break;
    }
    counted.push(entry);
  }
  const giveBack = () => Promise.all(counted.map(([rule, key]) => refundRateLimit(rule, key)));
  if (refusal) {
    await giveBack(); // a refused attempt did no work — it isn't a failure
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "platform.unlock.failure",
      entityType: "User",
      entityId: user.id,
      metadata: { reason: refusal.reason === "limited" ? "rate_limited" : "limiter_unavailable" },
    });
    if (refusal.reason === "unavailable") {
      return actionError("Accès plateforme temporairement indisponible. Réessayez plus tard.");
    }
    const minutes = retryAfterMinutes(refusal.retryAfterMs);
    return actionError(`Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? "s" : ""}.`);
  }

  const key = formData.get("key");
  const ok = typeof key === "string" && verifyPlatformKey(key.trim());
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: ok ? "platform.unlock.success" : "platform.unlock.failure",
    entityType: "User",
    entityId: user.id,
  });
  if (!ok) return actionError("Clé d'accès invalide.");
  await giveBack();
  await issuePlatformUnlock(user.id);
  redirect("/platform");
}

/** Ends the platform step-up for this session (the customer-side login stays). */
export async function lockPlatformAction(): Promise<void> {
  await requireUserForAction();
  await clearPlatformUnlock();
  redirect("/tableau-de-bord");
}
