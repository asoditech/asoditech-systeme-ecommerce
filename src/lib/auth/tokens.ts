import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/**
 * The one secure-token mechanism this app uses everywhere a raw secret has
 * to be handed to someone and only its hash kept at rest: session cookies
 * (src/lib/auth/session.ts), tenant-scoped user invitations, and password
 * resets (Phase 5 — docs/adr/0027-tenant-provisioning.md). A 256-bit random
 * token, URL-safe encoded; only its HMAC-SHA256 (keyed by `AUTH_SECRET`) is
 * ever written to the database, logged, or compared — the raw value exists
 * only in the URL/cookie handed to the one legitimate holder.
 */

export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(rawToken: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(rawToken).digest("hex");
}

/** Constant-time comparison helper for token/secret verification. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
