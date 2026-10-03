import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { hashToken } from "@/lib/auth/tokens";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * Platform step-up access (docs/adr/0053). `/platform` manages EVERY
 * customer's existence, plan and data, so being a platform admin
 * (`User.isPlatformAdmin`) and logged in is not enough: the session must
 * also be unlocked with the Platform Access Key.
 *
 * - The key is a long random secret held only by the platform owner. The
 *   deployment stores just its SHA-256 (`PLATFORM_ACCESS_KEY_SHA256`, 64 hex
 *   chars) — never the key itself, never in the database, never in source
 *   or the client bundle. Rotation = set a new hash and redeploy; every
 *   existing unlock is invalidated because the hash is part of the cookie
 *   signature. Recovery = whoever controls the deployment's environment
 *   variables generates a new key (the owner).
 * - An unlock is an httpOnly cookie, HMAC-signed with AUTH_SECRET and bound
 *   to the user AND their current session token: it cannot be replayed on
 *   another session and dies with logout. It lasts at most UNLOCK_TTL_MS.
 * - Fail-closed: in production, an unset/invalid hash means `/platform` is
 *   locked for everyone. Outside production with no hash configured the
 *   step-up is not required (local development and the test suite).
 */

export const PLATFORM_UNLOCK_COOKIE = "aec_platform";
const UNLOCK_TTL_MS = 8 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

function configuredKeyHash(): string | null {
  const raw = process.env.PLATFORM_ACCESS_KEY_SHA256?.trim().toLowerCase();
  return raw && HEX64.test(raw) ? raw : null;
}

/** Whether `/platform` needs the access key on this deployment. */
export function platformKeyRequired(): boolean {
  // Read at call time (like the tenant resolver), not from the parsed env.
  return configuredKeyHash() !== null || process.env.NODE_ENV === "production";
}

/** Whether a usable key hash is configured (production without one = locked). */
export function platformKeyConfigured(): boolean {
  return configuredKeyHash() !== null;
}

/** Constant-time check of a candidate key against the configured hash. */
export function verifyPlatformKey(candidate: string): boolean {
  const expected = configuredKeyHash();
  if (!expected || !candidate) return false;
  const actual = createHash("sha256").update(candidate, "utf8").digest();
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function signature(userId: string, sessionHash: string, expiresAt: number, keyHash: string): string {
  return createHmac("sha256", env.AUTH_SECRET)
    .update(`platform-unlock.v1.${userId}.${sessionHash}.${expiresAt}.${keyHash}`)
    .digest("hex");
}

async function currentSessionHash(): Promise<string | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  return raw ? hashToken(raw) : null;
}

/** Sets the unlock cookie for this user's CURRENT session. Call only after `verifyPlatformKey`. */
export async function issuePlatformUnlock(userId: string): Promise<void> {
  const keyHash = configuredKeyHash();
  const sessionHash = await currentSessionHash();
  if (!keyHash || !sessionHash) throw new Error("Accès plateforme indisponible.");
  const expiresAt = Date.now() + UNLOCK_TTL_MS;
  (await cookies()).set(PLATFORM_UNLOCK_COOKIE, `${expiresAt}.${signature(userId, sessionHash, expiresAt, keyHash)}`, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(UNLOCK_TTL_MS / 1000),
  });
}

/** Whether this user's current session is unlocked for `/platform`. */
export async function hasPlatformUnlock(userId: string): Promise<boolean> {
  if (!platformKeyRequired()) return true;
  const keyHash = configuredKeyHash();
  if (!keyHash) return false; // production with no key configured: locked
  const sessionHash = await currentSessionHash();
  const raw = (await cookies()).get(PLATFORM_UNLOCK_COOKIE)?.value;
  if (!sessionHash || !raw) return false;
  const [exp, sig] = raw.split(".");
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = signature(userId, sessionHash, expiresAt, keyHash);
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
}

export async function clearPlatformUnlock(): Promise<void> {
  (await cookies()).delete(PLATFORM_UNLOCK_COOKIE);
}
