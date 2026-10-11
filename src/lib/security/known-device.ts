import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * « Known device » (balanced login protection, 2026-10).
 *
 * After a successful login the browser receives a signed, expiring cookie
 * saying « this device signed in to <address> as <user> ». It is NOT an
 * authentication — it never skips the password, never creates a session —
 * it only exempts that device from the address-wide rate-limit bucket, so an
 * attacker who hammers a victim's address can't keep the victim out of
 * their own browsers. Threat model:
 *
 *  - Forgery: HMAC-SHA256 with AUTH_SECRET, purpose-bound (« known-device.v1 »)
 *    so no other signed value of the app can be replayed as one; compared in
 *    constant time; any malformed / oversized value is simply ignored.
 *  - Binding: the cookie carries the user id, a keyed tag of the normalized
 *    address (never the address itself) and a keyed stamp of the user's
 *    current password hash. A different address, a disabled user or ANY
 *    password change (reset included) invalidates every device at once.
 *  - Expiry and rotation: 30 days, re-issued (new nonce, new expiry) on each
 *    successful login; HttpOnly, SameSite=Lax, Secure in production.
 *  - Theft: a stolen cookie still needs the password and is held to its own
 *    per-device bucket (login:device, 10 / 15 min) plus the address+IP
 *    cooldowns — worth less than a fresh IP is to an attacker.
 *  - « Se déconnecter de toutes les sessions » clears the current device's
 *    cookie; other devices keep their (exemption-only) status until it
 *    expires or the password changes — revoking them all would need a
 *    per-user counter column (a migration), which this does not add.
 */

export const KNOWN_DEVICE_COOKIE = "aec_known_device";
export const KNOWN_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERSION = "kd1";
const MAX_COOKIE_LENGTH = 512;

export interface KnownDeviceClaim {
  userId: string;
  emailTag: string;
  stamp: string;
  nonce: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

function mac(purpose: string, data: string): Buffer {
  return createHmac("sha256", env.AUTH_SECRET).update(`${purpose}\0${data}`).digest();
}

/** Keyed tag of a NORMALIZED address — the cookie never contains the address. */
export function knownDeviceEmailTag(normalizedEmail: string): string {
  return mac("known-device.email.v1", normalizedEmail).subarray(0, 16).toString("base64url");
}

/** Keyed stamp of the current password hash — changes with the password. */
export function knownDevicePasswordStamp(passwordHash: string): string {
  return mac("known-device.stamp.v1", passwordHash).subarray(0, 16).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signKnownDevice(claim: KnownDeviceClaim): string {
  const payload = [VERSION, claim.userId, claim.emailTag, claim.stamp, claim.nonce, String(claim.exp)].join(".");
  return `${payload}.${mac("known-device.v1", payload).toString("base64url")}`;
}

/** A valid, unexpired, untampered claim — or null for anything else. */
export function parseKnownDevice(raw: string | null | undefined, now: number = Date.now()): KnownDeviceClaim | null {
  if (!raw || raw.length > MAX_COOKIE_LENGTH) return null;
  const parts = raw.split(".");
  if (parts.length !== 7 || parts[0] !== VERSION || parts.some((p) => p.length === 0)) return null;
  const payload = parts.slice(0, 6).join(".");
  if (!safeEqual(parts[6]!, mac("known-device.v1", payload).toString("base64url"))) return null;
  const exp = Number(parts[5]);
  if (!Number.isSafeInteger(exp) || exp * 1000 <= now) return null;
  return { userId: parts[1]!, emailTag: parts[2]!, stamp: parts[3]!, nonce: parts[4]!, exp };
}

/** The device claim of the current request for this (normalized) address — signature, expiry and address only. */
export async function readKnownDevice(normalizedEmail: string): Promise<KnownDeviceClaim | null> {
  let raw: string | undefined;
  try {
    raw = (await cookies()).get(KNOWN_DEVICE_COOKIE)?.value;
  } catch {
    return null; // outside a request scope
  }
  const claim = parseKnownDevice(raw);
  return claim && safeEqual(claim.emailTag, knownDeviceEmailTag(normalizedEmail)) ? claim : null;
}

/** The claim still describes this user as it is now: same id, ACTIVE, same password. */
export function knownDeviceMatchesUser(
  claim: KnownDeviceClaim,
  user: { id: string; status: string; passwordHash: string }
): boolean {
  return claim.userId === user.id && user.status === "ACTIVE" && safeEqual(claim.stamp, knownDevicePasswordStamp(user.passwordHash));
}

export function knownDeviceCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(KNOWN_DEVICE_TTL_MS / 1000),
  };
}

/** Issues (or rotates) this browser's known-device cookie after a successful login. */
export async function issueKnownDevice(user: { id: string; passwordHash: string }, normalizedEmail: string, now: number = Date.now()) {
  const value = signKnownDevice({
    userId: user.id,
    emailTag: knownDeviceEmailTag(normalizedEmail),
    stamp: knownDevicePasswordStamp(user.passwordHash),
    nonce: randomBytes(16).toString("base64url"),
    exp: Math.floor((now + KNOWN_DEVICE_TTL_MS) / 1000),
  });
  (await cookies()).set(KNOWN_DEVICE_COOKIE, value, knownDeviceCookieOptions());
}

export async function clearKnownDevice() {
  try {
    (await cookies()).delete(KNOWN_DEVICE_COOKIE);
  } catch {
    // outside a request scope — nothing to clear
  }
}
