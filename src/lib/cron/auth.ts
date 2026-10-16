import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Bearer check of the protected cron routes (src/app/api/cron/*). Pure:
 * the caller passes the configured secret. Refuses when no secret is
 * configured (never "open by default"); compares SHA-256 digests in
 * constant time, so neither the length nor a prefix of the secret leaks.
 */
export function isAuthorizedCronRequest(authorizationHeader: string | null, secret: string | null | undefined): boolean {
  if (!secret || secret.trim().length === 0) return false;
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
  if (!match) return false;
  const given = createHash("sha256").update(match[1].trim()).digest();
  const expected = createHash("sha256").update(secret.trim()).digest();
  return timingSafeEqual(given, expected);
}
