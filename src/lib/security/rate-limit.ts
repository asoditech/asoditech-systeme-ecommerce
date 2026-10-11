import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { headers } from "next/headers";
import { prismaBase } from "@/lib/prisma";
import { env } from "@/lib/env";

/**
 * Authentication rate limiting (Batch 1A hardening).
 *
 * PostgreSQL-backed fixed-window counters in `auth_rate_limits`, shared by
 * every serverless instance — no in-memory state, no external service. One
 * row per active bucket (never one per request); each hit is ONE atomic
 * `INSERT … ON CONFLICT … DO UPDATE`, so concurrent requests on any instance
 * can never lose an increment. A row whose window has ended is dead — the
 * next hit restarts it — and is deleted in bounded batches (see `sweep`).
 *
 * Keys are "<bucket>:" + HMAC-SHA256(AUTH_SECRET, normalized subject): no
 * plaintext email or IP is ever stored. Email subjects are trimmed and
 * lower-cased, so changing the case never yields a fresh bucket; IPv6
 * subjects are reduced to their /64 (one end-user allocation).
 *
 * Three shapes of check:
 *  - `consumeRateLimit` counts EVERY attempt, before the work (flood control);
 *  - `reserveProgressiveAttempt` (login — balanced protection, 2026-10): a
 *    few free attempts, then ONE attempt per growing, CAPPED cooldown
 *    (30 s → … → 15 min). The attempt is counted atomically BEFORE the work
 *    and the cooldown slot is claimed atomically, so concurrent attempts can
 *    never all slip through; a success refunds / clears. Never a lockout
 *    longer than the cap, so an attacker can at most slow a victim down —
 *    and a known device (src/lib/security/known-device.ts) is exempt from
 *    the address-wide bucket altogether;
 *  - `checkRateLimits` + `recordRateLimitFailures` count only FAILURES, the
 *    check running before the expensive work (kept for callers that need
 *    that shape; login and platform unlock no longer use it — a read/check/
 *    write sequence lets concurrent attempts all pass the check).
 *
 * Email-keyed buckets exist for any submitted address, account or not, so a
 * block never reveals whether an account exists.
 *
 * Failure policy is the caller's: "open" (login, password reset — a limiter
 * fault must not lock every merchant out; bcrypt still bounds guessing) or
 * "closed" (platform unlock). Either way the fault is logged without keys,
 * emails or IPs.
 *
 * Rollback switch: AUTH_RATE_LIMIT_MODE = "enforce" (default) | "observe"
 * (count and log, never block) | "off" (no database work at all).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export interface RateLimitRule {
  readonly bucket: string;
  readonly windowMs: number;
  readonly limit: number;
}

/** Free attempts per window, then one attempt per cooldown — the cooldowns grow and stop at the last one. */
export interface ProgressiveRule {
  readonly bucket: string;
  readonly windowMs: number;
  readonly free: number;
  readonly cooldownsMs: readonly number[];
}

export const RATE_LIMITS = {
  /** Every login attempt from one IP (counted before any work). */
  loginIp: { bucket: "login:ip", windowMs: 15 * MINUTE, limit: 40 },
  /** Every login attempt from one KNOWN device (its cookie nonce) — what a
   * stolen known-device cookie is worth: 10 guesses per 15 min, no more. */
  loginDevice: { bucket: "login:device", windowMs: 15 * MINUTE, limit: 10 },
  /** Every password-reset request from one IP. */
  resetRequestIp: { bucket: "reset_req:ip", windowMs: HOUR, limit: 10 },
  /** Every password-reset request for one email from an unknown device (silently absorbed beyond the limit). */
  resetRequestEmail: { bucket: "reset_req:email", windowMs: HOUR, limit: 3 },
  /** Same, per day — bounds the mail an address can receive from unknown devices. */
  resetRequestEmailDaily: { bucket: "reset_req:email:daily", windowMs: 24 * HOUR, limit: 10 },
  /** Reset requests from a KNOWN device of this address: its own quota, so
   * an attacker exhausting reset_req:email never blocks the owner's recovery. */
  resetRequestDevice: { bucket: "reset_req:device", windowMs: HOUR, limit: 3 },
  /** Every password-reset confirmation from one IP (flood control — the token is 256-bit). */
  resetConfirmIp: { bucket: "reset_confirm:ip", windowMs: 15 * MINUTE, limit: 20 },
  /** Failed platform unlocks for one platform admin. */
  unlockUser: { bucket: "unlock:user", windowMs: 15 * MINUTE, limit: 5 },
  unlockUserDaily: { bucket: "unlock:user:daily", windowMs: 24 * HOUR, limit: 10 },
} as const satisfies Record<string, RateLimitRule>;

const SECOND = 1000;

/**
 * Login guessing (balanced protection). The address-wide bucket applies to
 * UNKNOWN devices only (known-device.ts), so whatever an attacker does with a
 * victim's address, the victim's own browsers keep their normal access; and a
 * cooldown never exceeds 15 min. A completed password reset clears both.
 */
export const PROGRESSIVE_LIMITS = {
  /** One address from one IP: 4 free attempts, then 30 s, 1, 2, 5, 15 min. */
  loginEmailIp: { bucket: "login:email_ip", windowMs: HOUR, free: 4, cooldownsMs: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE] },
  /** One address from anywhere, unknown devices (distributed guessing): 9 free, then 1, 2, 5, 15 min. */
  loginEmail: { bucket: "login:email", windowMs: HOUR, free: 9, cooldownsMs: [MINUTE, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE] },
} as const satisfies Record<string, ProgressiveRule>;

/** The cooldown that follows the n-th attempt beyond the free ones (1-based), capped at the last. */
export function progressiveCooldownMs(rule: ProgressiveRule, attemptsBeyondFree: number): number {
  const i = Math.min(Math.max(attemptsBeyondFree, 1), rule.cooldownsMs.length) - 1;
  return rule.cooldownsMs[i]!;
}

/** At most one bounded opportunistic sweep per this interval, across every instance. */
const SWEEP_RULE: RateLimitRule = { bucket: "maintenance:sweep", windowMs: 10 * MINUTE, limit: 1 };
export const OPPORTUNISTIC_SWEEP_BATCH = 200;

export type RateLimitMode = "enforce" | "observe" | "off";
export type FailurePolicy = "open" | "closed";

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "limited"; retryAfterMs: number }
  | { allowed: false; reason: "unavailable" };

/** Read at call time (like PLATFORM_ACCESS_KEY_SHA256) so it can change without a code change. */
export function rateLimitMode(): RateLimitMode {
  const raw = process.env.AUTH_RATE_LIMIT_MODE?.trim().toLowerCase();
  return raw === "observe" || raw === "off" ? raw : "enforce";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The rate-limit subject for an IP: IPv4 as is, IPv6 as its /64 prefix
 * (an attacker trivially rotates addresses inside one allocation), an
 * IPv4-mapped IPv6 address as its IPv4. Null for anything unparsable.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  let ip = raw?.trim() ?? "";
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;

  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;

  const [head = "", tail = ""] = lower.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = lower.includes("::") ? (tail ? tail.split(":") : []) : [];
  // An embedded dotted IPv4 tail occupies two groups; it never reaches the /64 prefix kept below.
  const groupCount = (parts: string[]) => parts.reduce((n, p) => n + (p.includes(".") ? 2 : 1), 0);
  const missing = 8 - groupCount(headParts) - groupCount(tailParts);
  const groups = lower.includes("::") ? [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts] : headParts;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * The client IP from request headers, trusting only what the platform sets.
 * On Vercel (`VERCEL` env) the edge sets `x-vercel-forwarded-for` and
 * overwrites `x-forwarded-for` — a client-supplied value never survives — so
 * either's first entry is the client. Anywhere else a client can send its
 * own `x-forwarded-for`: only `x-real-ip` (set by the operator's reverse
 * proxy) or the LAST `x-forwarded-for` hop (appended by the nearest proxy,
 * not the client) is used — rotating a forged header buys nothing.
 */
export function clientIpFromHeaders(get: (name: string) => string | null | undefined, onVercel: boolean): string | null {
  const xff = get("x-forwarded-for")?.split(",") ?? [];
  if (onVercel) {
    return normalizeIp(get("x-vercel-forwarded-for")?.split(",")[0]) ?? normalizeIp(xff[0]) ?? normalizeIp(get("x-real-ip"));
  }
  return normalizeIp(get("x-real-ip")) ?? normalizeIp(xff[xff.length - 1]);
}

/** The client IP of the current request (see clientIpFromHeaders). */
export async function getClientIp(): Promise<string | null> {
  try {
    const hdrs = await headers();
    return clientIpFromHeaders((name) => hdrs.get(name), Boolean(process.env.VERCEL));
  } catch {
    return null; // outside a request scope
  }
}

/** "<bucket>:" + keyed hash of the subject parts — never the subject itself. */
export function rateLimitKey(rule: { readonly bucket: string }, ...subject: string[]): string {
  const digest = createHmac("sha256", env.AUTH_SECRET)
    .update(`rate-limit.v1\0${rule.bucket}\0${subject.join("\0")}`)
    .digest("hex");
  return `${rule.bucket}:${digest}`;
}

export function retryAfterMinutes(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / MINUTE));
}

/** Structured, secret-free log line for a limiter fault. */
function logBackendError(op: string, bucket: string, error: unknown) {
  const e = error as { code?: unknown; meta?: { code?: unknown }; name?: unknown } | null;
  console.error("[rate-limit] backend_error", {
    op,
    bucket,
    code: (typeof e?.meta?.code === "string" && e.meta.code) || (typeof e?.code === "string" && e.code) || e?.name || "unknown",
  });
}

function logBlocked(bucket: string, mode: RateLimitMode) {
  console.warn(mode === "observe" ? "[rate-limit] would_block" : "[rate-limit] blocked", { bucket });
}

interface BucketState {
  count: number;
  windowEnd: Date;
}

/** One atomic upsert: start a fresh window when the stored one has ended, else increment. */
async function hit(rule: RateLimitRule, key: string): Promise<BucketState> {
  const windowSeconds = rule.windowMs / 1000;
  const rows = await prismaBase.$queryRaw<{ count: number; window_end: Date }[]>`
    INSERT INTO "auth_rate_limits" ("key", "count", "window_end")
    VALUES (${key}, 1, now() + make_interval(secs => ${windowSeconds}::double precision))
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "auth_rate_limits"."window_end" <= now() THEN 1 ELSE "auth_rate_limits"."count" + 1 END,
      "window_end" = CASE WHEN "auth_rate_limits"."window_end" <= now()
                          THEN now() + make_interval(secs => ${windowSeconds}::double precision)
                          ELSE "auth_rate_limits"."window_end" END
    RETURNING "count", "window_end"`;
  const row = rows[0]!;
  const state = { count: Number(row.count), windowEnd: row.window_end };
  // A fresh window is the (rare) moment to piggyback the bounded sweep.
  if (state.count === 1 && rule.bucket !== SWEEP_RULE.bucket) await maybeSweep();
  return state;
}

/** Current (unexpired) state of each key; expired or absent keys are omitted. */
async function peek(keys: string[]): Promise<Map<string, BucketState>> {
  if (keys.length === 0) return new Map();
  const rows = await prismaBase.$queryRaw<{ key: string; count: number; window_end: Date }[]>`
    SELECT "key", "count", "window_end" FROM "auth_rate_limits"
    WHERE "key" = ANY(${keys}::text[]) AND "window_end" > now()`;
  return new Map(rows.map((r) => [r.key, { count: Number(r.count), windowEnd: r.window_end }]));
}

/**
 * Deletes at most `batchSize` rows whose window ended before `cutoff`,
 * oldest first, through the window_end index (never a full scan). Rows
 * another transaction is updating are skipped, not waited on.
 *
 * MATERIALIZED on purpose: a plain `WHERE key IN (SELECT … LIMIT n FOR
 * UPDATE SKIP LOCKED)` may be re-scanned by the planner (nested loop), each
 * scan locking a DIFFERENT n rows — deleting more than one batch. The CTE
 * is evaluated exactly once.
 */
export async function deleteExpiredRateLimitBatch(cutoff: Date, batchSize: number): Promise<number> {
  return prismaBase.$executeRaw`
    WITH "batch" AS MATERIALIZED (
      SELECT "key" FROM "auth_rate_limits"
      WHERE "window_end" < ${cutoff}
      ORDER BY "window_end"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "auth_rate_limits" AS t USING "batch" WHERE t."key" = "batch"."key"`;
}

/**
 * Deterministic, low-frequency cleanup without a scheduler: only a hit that
 * opens a NEW window gets here, and only the first such hit per SWEEP_RULE
 * window (a row in this same table, so every instance agrees) deletes one
 * bounded batch. Never fails the caller.
 */
async function maybeSweep(): Promise<void> {
  try {
    const marker = await hit(SWEEP_RULE, SWEEP_RULE.bucket);
    if (marker.count === 1) await deleteExpiredRateLimitBatch(new Date(), OPPORTUNISTIC_SWEEP_BATCH);
  } catch (error) {
    logBackendError("sweep", SWEEP_RULE.bucket, error);
  }
}

/** Counts this attempt, then decides: allowed while the count stays within the limit. */
export async function consumeRateLimit(rule: RateLimitRule, key: string, onError: FailurePolicy): Promise<RateLimitDecision> {
  const mode = rateLimitMode();
  if (mode === "off") return { allowed: true };
  let state: BucketState;
  try {
    state = await hit(rule, key);
  } catch (error) {
    logBackendError("consume", rule.bucket, error);
    return onError === "closed" ? { allowed: false, reason: "unavailable" } : { allowed: true };
  }
  if (state.count <= rule.limit) return { allowed: true };
  logBlocked(rule.bucket, mode);
  if (mode === "observe") return { allowed: true };
  return { allowed: false, reason: "limited", retryAfterMs: Math.max(0, state.windowEnd.getTime() - Date.now()) };
}

/** Failure buckets: refused once any bucket already holds `limit` failures (checked before the work). */
export async function checkRateLimits(
  buckets: readonly (readonly [RateLimitRule, string])[],
  onError: FailurePolicy
): Promise<RateLimitDecision> {
  const mode = rateLimitMode();
  if (mode === "off" || buckets.length === 0) return { allowed: true };
  let states: Map<string, BucketState>;
  try {
    states = await peek(buckets.map(([, key]) => key));
  } catch (error) {
    logBackendError("check", buckets.map(([rule]) => rule.bucket).join(","), error);
    return onError === "closed" ? { allowed: false, reason: "unavailable" } : { allowed: true };
  }
  let retryAfterMs = 0;
  for (const [rule, key] of buckets) {
    const state = states.get(key);
    if (state && state.count >= rule.limit) {
      logBlocked(rule.bucket, mode);
      retryAfterMs = Math.max(retryAfterMs, state.windowEnd.getTime() - Date.now());
    }
  }
  if (retryAfterMs <= 0 || mode === "observe") return { allowed: true };
  return { allowed: false, reason: "limited", retryAfterMs };
}

/** Records one failure in each bucket (one atomic upsert per bucket). Never throws. */
export async function recordRateLimitFailures(buckets: readonly (readonly [RateLimitRule, string])[]): Promise<void> {
  if (rateLimitMode() === "off") return;
  await Promise.all(
    buckets.map(async ([rule, key]) => {
      try {
        await hit(rule, key);
      } catch (error) {
        logBackendError("record", rule.bucket, error);
      }
    })
  );
}

/** Forgets one bucket (e.g. login:email_ip after a successful login). Never throws. */
export async function clearRateLimit(rule: RateLimitRule, key: string): Promise<void> {
  if (rateLimitMode() === "off") return;
  try {
    await prismaBase.$executeRaw`DELETE FROM "auth_rate_limits" WHERE "key" = ${key}`;
  } catch (error) {
    logBackendError("clear", rule.bucket, error);
  }
}

/** Gives one counted attempt back (a success, or an attempt refused by a later bucket). Never throws. */
export async function refundRateLimit(rule: { readonly bucket: string }, key: string): Promise<void> {
  if (rateLimitMode() === "off") return;
  try {
    await prismaBase.$executeRaw`
      UPDATE "auth_rate_limits" SET "count" = GREATEST("count" - 1, 0)
      WHERE "key" = ${key} AND "window_end" > now()`;
  } catch (error) {
    logBackendError("refund", rule.bucket, error);
  }
}

const coolKey = (key: string) => `${key}:cool`;

/**
 * Claims the cooldown slot: succeeds (and starts a `delayMs` cooldown) only
 * if no cooldown is running — one atomic upsert, so of N concurrent
 * attempts exactly one wins. Returns the running cooldown's end otherwise.
 */
async function claimCooldown(key: string, delayMs: number): Promise<{ claimed: true } | { claimed: false; until: Date }> {
  const seconds = delayMs / 1000;
  const rows = await prismaBase.$queryRaw<{ window_end: Date }[]>`
    INSERT INTO "auth_rate_limits" ("key", "count", "window_end")
    VALUES (${key}, 1, now() + make_interval(secs => ${seconds}::double precision))
    ON CONFLICT ("key") DO UPDATE SET
      "count" = "auth_rate_limits"."count" + 1,
      "window_end" = now() + make_interval(secs => ${seconds}::double precision)
    WHERE "auth_rate_limits"."window_end" <= now()
    RETURNING "window_end"`;
  if (rows.length > 0) return { claimed: true };
  const running = await prismaBase.$queryRaw<{ window_end: Date }[]>`
    SELECT "window_end" FROM "auth_rate_limits" WHERE "key" = ${key}`;
  return { claimed: false, until: running[0]?.window_end ?? new Date() };
}

export type ProgressiveDecision =
  /** `counted`: this attempt holds one count — refund it on success. */
  | { allowed: true; counted: boolean }
  | { allowed: false; reason: "limited"; retryAfterMs: number }
  | { allowed: false; reason: "unavailable" };

/**
 * Counts this attempt (atomically, before the work), then: allowed while
 * within the free attempts; beyond them, allowed only by claiming the
 * cooldown slot — which starts the next, longer cooldown. A refused attempt
 * is not counted (it did no work) so hammering never escalates past what
 * the attempts that actually ran deserve.
 */
export async function reserveProgressiveAttempt(rule: ProgressiveRule, key: string, onError: FailurePolicy): Promise<ProgressiveDecision> {
  const mode = rateLimitMode();
  if (mode === "off") return { allowed: true, counted: false };
  try {
    const state = await hit({ bucket: rule.bucket, windowMs: rule.windowMs, limit: Number.MAX_SAFE_INTEGER }, key);
    if (state.count <= rule.free) return { allowed: true, counted: true };
    const cooldown = await claimCooldown(coolKey(key), progressiveCooldownMs(rule, state.count - rule.free));
    if (cooldown.claimed) return { allowed: true, counted: true };
    await refundRateLimit(rule, key);
    logBlocked(rule.bucket, mode);
    if (mode === "observe") return { allowed: true, counted: false };
    return { allowed: false, reason: "limited", retryAfterMs: Math.max(1000, cooldown.until.getTime() - Date.now()) };
  } catch (error) {
    logBackendError("reserve", rule.bucket, error);
    return onError === "closed" ? { allowed: false, reason: "unavailable" } : { allowed: true, counted: false };
  }
}

/** Forgets a progressive bucket and its cooldown (a success from this IP, a completed reset). Never throws. */
export async function clearProgressive(rule: ProgressiveRule, key: string): Promise<void> {
  if (rateLimitMode() === "off") return;
  try {
    await prismaBase.$executeRaw`DELETE FROM "auth_rate_limits" WHERE "key" IN (${key}, ${coolKey(key)})`;
  } catch (error) {
    logBackendError("clear", rule.bucket, error);
  }
}

/** « 30 secondes » / « 2 minutes » — for the refusal messages. */
export function formatRetryAfter(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  if (seconds < 60) return `${seconds} seconde${seconds > 1 ? "s" : ""}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes > 1 ? "s" : ""}`;
}
