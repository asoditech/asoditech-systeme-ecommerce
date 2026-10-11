import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaBase } from "@/lib/prisma";
import {
  OPPORTUNISTIC_SWEEP_BATCH,
  checkRateLimits,
  clearRateLimit,
  consumeRateLimit,
  deleteExpiredRateLimitBatch,
  getClientIp,
  normalizeEmail,
  normalizeIp,
  rateLimitKey,
  recordRateLimitFailures,
  type RateLimitRule,
} from "@/lib/security/rate-limit";
import { cleanupExpiredEphemeralData } from "@/lib/maintenance/expired-data";
import { resetDb } from "../helpers/db";
import { mockHeaders } from "../mocks/cookie-store";

/**
 * Batch 1A — the PostgreSQL-backed auth rate limiter itself
 * (src/lib/security/rate-limit.ts), against the real test database.
 */

const RULE: RateLimitRule = { bucket: "test:bucket", windowMs: 15 * 60 * 1000, limit: 3 };

async function row(key: string) {
  return prismaBase.authRateLimit.findUnique({ where: { key } });
}
async function expireNow(key: string) {
  await prismaBase.authRateLimit.update({ where: { key }, data: { windowEnd: new Date(Date.now() - 1000) } });
}
async function seedExpired(n: number, prefix = "expired") {
  await prismaBase.authRateLimit.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      key: `${prefix}:${i}`,
      count: 1,
      windowEnd: new Date(Date.now() - 3 * 60 * 60 * 1000 - i * 1000),
    })),
  });
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mockHeaders.set("x-forwarded-for", "127.0.0.1");
  mockHeaders.delete("x-real-ip");
  await resetDb();
});

describe("consumeRateLimit (count every attempt)", () => {
  it("allows up to the limit, then blocks with a retry delay", async () => {
    const key = rateLimitKey(RULE, "subject");
    for (let i = 0; i < RULE.limit; i += 1) {
      expect(await consumeRateLimit(RULE, key, "open")).toEqual({ allowed: true });
    }
    const blocked = await consumeRateLimit(RULE, key, "open");
    expect(blocked).toMatchObject({ allowed: false, reason: "limited" });
    if (!blocked.allowed && blocked.reason === "limited") {
      expect(blocked.retryAfterMs).toBeGreaterThan(14 * 60 * 1000);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(RULE.windowMs);
    }
    expect((await row(key))?.count).toBe(RULE.limit + 1);
  });

  it("starts a fresh window once the stored one has ended", async () => {
    const key = rateLimitKey(RULE, "subject");
    for (let i = 0; i < RULE.limit + 1; i += 1) await consumeRateLimit(RULE, key, "open");
    await expireNow(key);
    expect(await consumeRateLimit(RULE, key, "open")).toEqual({ allowed: true });
    const fresh = await row(key);
    expect(fresh?.count).toBe(1);
    expect(fresh!.windowEnd.getTime()).toBeGreaterThan(Date.now() + 14 * 60 * 1000);
  });

  it("is atomic under concurrency: no lost increment, exactly `limit` requests allowed", async () => {
    const key = rateLimitKey(RULE, "concurrent");
    const decisions = await Promise.all(Array.from({ length: 25 }, () => consumeRateLimit(RULE, key, "open")));
    expect(decisions.filter((d) => d.allowed)).toHaveLength(RULE.limit);
    expect((await row(key))?.count).toBe(25);
    expect(await prismaBase.authRateLimit.count({ where: { key } })).toBe(1);
  });

  it("fails open or closed as asked when the backend cannot be evaluated, logging no secret", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prismaBase, "$queryRaw").mockRejectedValue(Object.assign(new Error("boom"), { code: "P2010" }));
    const key = rateLimitKey(RULE, "someone@example.com");
    expect(await consumeRateLimit(RULE, key, "open")).toEqual({ allowed: true });
    expect(await consumeRateLimit(RULE, key, "closed")).toEqual({ allowed: false, reason: "unavailable" });
    expect(await checkRateLimits([[RULE, key]], "closed")).toEqual({ allowed: false, reason: "unavailable" });
    expect(error).toHaveBeenCalledWith("[rate-limit] backend_error", expect.objectContaining({ bucket: RULE.bucket, code: "P2010" }));
    expect(JSON.stringify(error.mock.calls)).not.toContain(key);
    expect(JSON.stringify(error.mock.calls)).not.toContain("someone@example.com");
  });

  it("observe mode counts and logs but never blocks; off mode does no database work", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AUTH_RATE_LIMIT_MODE", "observe");
    const key = rateLimitKey(RULE, "observed");
    for (let i = 0; i < RULE.limit + 2; i += 1) expect((await consumeRateLimit(RULE, key, "closed")).allowed).toBe(true);
    expect((await row(key))?.count).toBe(RULE.limit + 2);
    expect(warn).toHaveBeenCalledWith("[rate-limit] would_block", { bucket: RULE.bucket });

    vi.stubEnv("AUTH_RATE_LIMIT_MODE", "off");
    const offKey = rateLimitKey(RULE, "off");
    expect((await consumeRateLimit(RULE, offKey, "closed")).allowed).toBe(true);
    expect(await row(offKey)).toBeNull();
  });
});

describe("checkRateLimits + recordRateLimitFailures (count failures)", () => {
  it("blocks once a bucket holds `limit` failures, without counting the check itself", async () => {
    const key = rateLimitKey(RULE, "failures");
    for (let i = 0; i < RULE.limit - 1; i += 1) await recordRateLimitFailures([[RULE, key]]);
    expect(await checkRateLimits([[RULE, key]], "open")).toEqual({ allowed: true });
    expect(await checkRateLimits([[RULE, key]], "open")).toEqual({ allowed: true }); // a check never increments
    await recordRateLimitFailures([[RULE, key]]);
    expect(await checkRateLimits([[RULE, key]], "open")).toMatchObject({ allowed: false, reason: "limited" });
    await expireNow(key);
    expect(await checkRateLimits([[RULE, key]], "open")).toEqual({ allowed: true });
  });

  it("clearRateLimit forgets exactly one bucket", async () => {
    const a = rateLimitKey(RULE, "a");
    const b = rateLimitKey(RULE, "b");
    await recordRateLimitFailures([[RULE, a], [RULE, b]]);
    await clearRateLimit(RULE, a);
    expect(await row(a)).toBeNull();
    expect((await row(b))?.count).toBe(1);
  });
});

describe("keys and subject normalization", () => {
  it("mixed-case / padded emails normalize to the same key", () => {
    expect(normalizeEmail("  Owner@Example.COM ")).toBe("owner@example.com");
    expect(rateLimitKey(RULE, normalizeEmail("Owner@Example.COM"))).toBe(rateLimitKey(RULE, normalizeEmail("owner@example.com")));
    expect(rateLimitKey(RULE, "a")).not.toBe(rateLimitKey({ ...RULE, bucket: "other" }, "a"));
  });

  it("buckets IPv6 by /64, keeps IPv4, unwraps IPv4-mapped addresses, rejects garbage", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp("2001:db8:abcd:12:1::5")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeIp("2001:0db8:abcd:0012:ffff:0000:0000:0001")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeIp("[2001:db8:abcd:12::9]")).toBe("2001:db8:abcd:12::/64");
    expect(normalizeIp("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(normalizeIp("2001:db8:abcd:13::1")).not.toBe(normalizeIp("2001:db8:abcd:12::1"));
    expect(normalizeIp("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it("trusts only platform-set values: on Vercel the first x-forwarded-for entry, elsewhere x-real-ip or the last hop", async () => {
    vi.stubEnv("VERCEL", "1");
    mockHeaders.set("x-forwarded-for", "2001:db8:1:2:3:4:5:6, 10.0.0.1");
    expect(await getClientIp()).toBe("2001:db8:1:2::/64");
    vi.stubEnv("VERCEL", "");
    expect(await getClientIp()).toBe("10.0.0.1"); // the client-supplied first hop is not trusted off Vercel
    mockHeaders.set("x-forwarded-for", "garbage");
    mockHeaders.set("x-real-ip", "198.51.100.9");
    expect(await getClientIp()).toBe("198.51.100.9");
    vi.unstubAllEnvs();
  });

  it("stores only an HMAC — never the plaintext email or IP", async () => {
    const email = "victim@example.com";
    const ip = "203.0.113.50";
    await recordRateLimitFailures([
      [RULE, rateLimitKey(RULE, email)],
      [RULE, rateLimitKey(RULE, email, ip)],
    ]);
    // The only other row is the constant, subject-free sweep marker.
    const all = (await prismaBase.authRateLimit.findMany()).map((r) => r.key);
    expect(all.filter((k) => !k.startsWith("test:bucket:"))).toEqual(["maintenance:sweep"]);
    const keys = all.filter((k) => k.startsWith("test:bucket:"));
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^test:bucket:[0-9a-f]{64}$/);
      expect(key).not.toContain(email);
      expect(key).not.toContain(ip);
    }
  });
});

describe("cleanup is bounded", () => {
  it("deleteExpiredRateLimitBatch deletes at most one batch of expired rows, oldest first, never a live one", async () => {
    await seedExpired(30);
    const live = rateLimitKey(RULE, "live");
    await consumeRateLimit(RULE, live, "open"); // also opens the sweep window (deletes ≤ 200 — all 30)
    await seedExpired(30, "again");
    expect(await deleteExpiredRateLimitBatch(new Date(), 10)).toBe(10);
    expect(await prismaBase.authRateLimit.count({ where: { key: { startsWith: "again:" } } })).toBe(20);
    expect(await row(live)).not.toBeNull();
  });

  it("the opportunistic sweep runs at most once per sweep window and deletes one bounded batch", async () => {
    await seedExpired(OPPORTUNISTIC_SWEEP_BATCH + 5);
    await consumeRateLimit(RULE, rateLimitKey(RULE, "first-new-window"), "open");
    expect(await prismaBase.authRateLimit.count({ where: { key: { startsWith: "expired:" } } })).toBe(5);

    await seedExpired(10, "later");
    await consumeRateLimit(RULE, rateLimitKey(RULE, "second-new-window"), "open"); // same sweep window: no sweep
    await consumeRateLimit(RULE, rateLimitKey(RULE, "first-new-window"), "open"); // not a new window: no sweep
    expect(await prismaBase.authRateLimit.count({ where: { key: { startsWith: "later:" } } })).toBe(10);
  });

  it("cleanupExpiredEphemeralData removes rate-limit rows past the grace period only", async () => {
    await seedExpired(25);
    const live = rateLimitKey(RULE, "live");
    await prismaBase.authRateLimit.create({ data: { key: live, count: 2, windowEnd: new Date(Date.now() + 60_000) } });
    // Ended 10 minutes ago: dead, but inside the default 1 h grace — kept this run.
    await prismaBase.authRateLimit.create({ data: { key: "recent", count: 1, windowEnd: new Date(Date.now() - 10 * 60_000) } });

    const res = await cleanupExpiredEphemeralData();
    expect(res.authRateLimits).toBe(25);
    expect(await row(live)).not.toBeNull();
    expect(await row("recent")).not.toBeNull();
    expect((await cleanupExpiredEphemeralData()).authRateLimits).toBe(0);
  });
});
