import "server-only";

import { prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";
import { deleteExpiredRateLimitBatch } from "@/lib/security/rate-limit";

/**
 * Expired-data cleanup — the purely technical, short-lived tables only:
 * sessions, password reset tokens, Google OAuth states and authentication
 * rate-limit buckets. Nothing else is touched (no audit, notification,
 * webhook, backup or business row).
 *
 * Each row is deleted only when it can no longer be used by its own flow,
 * using that flow's existing expiry field:
 *  - Session: rejected once `expiresAt` has passed (src/lib/auth/session.ts);
 *    an expired session is never renewed, so it can never become valid again.
 *  - PasswordResetToken: usable only while unused AND not expired
 *    (src/lib/auth/token-lookup.ts). A consumed token is kept until its own
 *    expiry (a used link is still recognised as « déjà utilisé » meanwhile) —
 *    only the expiry decides, used or not.
 *  - GoogleOAuthState: consumed on return and rejected once expired
 *    (src/lib/backup/google-drive-service.ts); an abandoned flow leaves a row
 *    that is dead after `expiresAt`.
 *  - AuthRateLimit: a bucket whose `windowEnd` has passed is restarted by its
 *    next hit (src/lib/security/rate-limit.ts), so its row is dead. Deleted in
 *    bounded batches through the window_end index (at most
 *    RATE_LIMIT_CLEANUP_BATCH × RATE_LIMIT_CLEANUP_MAX_BATCHES rows per run;
 *    a later run continues), never one unbounded statement.
 *
 * Safety margin: a row must have expired more than `graceMs` ago (1 hour by
 * default), so nothing at its expiry instant (e.g. a session renewed in the
 * same request) can be affected. Idempotent: a second run deletes nothing.
 *
 * Cross-tenant by nature (a maintenance task, not a user request): runs
 * unscoped through `prismaBase`, like the token lookups. No scheduler exists
 * in this codebase yet — this function is meant to be called by one later
 * (e.g. a protected route hit by a cron); nothing calls it automatically today.
 */

export const EXPIRED_DATA_GRACE_MS = 60 * 60 * 1000;
export const RATE_LIMIT_CLEANUP_BATCH = 1000;
export const RATE_LIMIT_CLEANUP_MAX_BATCHES = 10;

export interface ExpiredDataCleanupResult {
  sessions: number;
  passwordResetTokens: number;
  googleOAuthStates: number;
  authRateLimits: number;
  /** Rows expired before this instant were eligible. */
  cutoff: Date;
}

export async function cleanupExpiredEphemeralData(
  opts: { now?: Date; graceMs?: number } = {}
): Promise<ExpiredDataCleanupResult> {
  const now = opts.now ?? new Date();
  const graceMs = Math.max(0, opts.graceMs ?? EXPIRED_DATA_GRACE_MS);
  const cutoff = new Date(now.getTime() - graceMs);
  const expired = { expiresAt: { lt: cutoff } };

  return runUnscoped("maintenance:expired-data-cleanup", async () => {
    const [sessions, passwordResetTokens, googleOAuthStates] = await Promise.all([
      prismaBase.session.deleteMany({ where: expired }),
      prismaBase.passwordResetToken.deleteMany({ where: expired }),
      prismaBase.googleOAuthState.deleteMany({ where: expired }),
    ]);
    let authRateLimits = 0;
    for (let batch = 0; batch < RATE_LIMIT_CLEANUP_MAX_BATCHES; batch += 1) {
      const deleted = await deleteExpiredRateLimitBatch(cutoff, RATE_LIMIT_CLEANUP_BATCH);
      authRateLimits += deleted;
      if (deleted < RATE_LIMIT_CLEANUP_BATCH) break;
    }
    return {
      sessions: sessions.count,
      passwordResetTokens: passwordResetTokens.count,
      googleOAuthStates: googleOAuthStates.count,
      authRateLimits,
      cutoff,
    };
  });
}
