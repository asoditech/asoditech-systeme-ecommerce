import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Proving a user owns the WhatsApp number they entered — docs/adr/0058.
 * A 6-digit code is sent to that number (Meta "Authentication" template);
 * the user types it back. Only an HMAC of the code is stored (in
 * `User.whatsappVerification`), bound to the user AND the number, so a
 * code for one number never verifies another. Pure helpers, no DB.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_SENDS_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60_000;

export interface PendingVerification {
  phone: string;
  codeHash: string;
  expiresAt: string; // ISO
  attempts: number;
  /** ISO timestamps of code sends in the last 24 h (cost + spam guard). */
  sends: string[];
}

export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashVerificationCode(secret: string, userId: string, phone: string, code: string): string {
  return createHmac("sha256", secret).update(`whatsapp-verify:${userId}:${phone}:${code}`).digest("hex");
}

export function parsePendingVerification(value: unknown): PendingVerification | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<PendingVerification>;
  if (typeof v.phone !== "string" || typeof v.codeHash !== "string" || typeof v.expiresAt !== "string") return null;
  return {
    phone: v.phone,
    codeHash: v.codeHash,
    expiresAt: v.expiresAt,
    attempts: typeof v.attempts === "number" ? v.attempts : 0,
    sends: Array.isArray(v.sends) ? v.sends.filter((s): s is string => typeof s === "string") : [],
  };
}

/** Sends still inside the 24 h window. */
export function recentSends(pending: PendingVerification | null, now: Date): string[] {
  return (pending?.sends ?? []).filter((s) => now.getTime() - new Date(s).getTime() < DAY_MS);
}

export function sendRefusal(pending: PendingVerification | null, now: Date): string | null {
  const sends = recentSends(pending, now);
  if (sends.length >= MAX_SENDS_PER_DAY) return "Trop de codes demandés aujourd'hui. Réessayez demain.";
  const last = sends.at(-1);
  if (last && now.getTime() - new Date(last).getTime() < RESEND_COOLDOWN_MS)
    return "Un code vient d'être envoyé. Patientez une minute avant d'en demander un autre.";
  return null;
}

export type CodeCheck = "ok" | "mismatch" | "expired" | "too_many_attempts" | "no_pending";

export function checkVerificationCode(
  pending: PendingVerification | null,
  input: { secret: string; userId: string; phone: string; code: string; now: Date }
): CodeCheck {
  if (!pending || pending.phone !== input.phone) return "no_pending";
  if (pending.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
  if (input.now.getTime() > new Date(pending.expiresAt).getTime()) return "expired";
  if (!/^\d{6}$/.test(input.code)) return "mismatch";
  const expected = Buffer.from(pending.codeHash, "hex");
  const actual = Buffer.from(hashVerificationCode(input.secret, input.userId, input.phone, input.code), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? "ok" : "mismatch";
}
