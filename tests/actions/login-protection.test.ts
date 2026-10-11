import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { loginAction, logoutAllSessionsAction } from "@/actions/auth";
import { requestPasswordResetAction, resetPasswordAction } from "@/actions/password-reset";
import {
  PROGRESSIVE_LIMITS,
  RATE_LIMITS,
  clientIpFromHeaders,
  formatRetryAfter,
  progressiveCooldownMs,
  rateLimitKey,
} from "@/lib/security/rate-limit";
import {
  KNOWN_DEVICE_COOKIE,
  KNOWN_DEVICE_TTL_MS,
  knownDeviceCookieOptions,
  knownDeviceEmailTag,
  knownDevicePasswordStamp,
  parseKnownDevice,
  signKnownDevice,
} from "@/lib/security/known-device";
import { createSession } from "@/lib/auth/session";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { mockCookieStore, mockHeaders } from "../mocks/cookie-store";
import { flushAfterTasks } from "../setup";

/**
 * S4 — balanced login protection: progressive, capped cooldowns (never a
 * lockout), race-safe counting, a known-device exemption that is never an
 * authentication, and password-reset quotas an attacker can't turn against
 * the owner. Real test database, real bcrypt.
 */

const PASSWORD = "correct-horse-battery-staple";
const INVALID = "E-mail ou mot de passe incorrect.";
const IP = "127.0.0.1";

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const login = (email: string, password: string) => settle(loginAction(undefined, fd({ email, password })));
const errorOf = (r: Awaited<ReturnType<typeof login>>) => (r.ok && !r.v.ok ? r.v.error : null);
const succeeded = (r: Awaited<ReturnType<typeof login>>) => !r.ok; // RedirectSignal = success
const setIp = (ip: string) => mockHeaders.set("x-forwarded-for", ip);

const keyOf = (rule: { bucket: string }, ...subject: string[]) => rateLimitKey(rule, ...subject);
const row = (key: string) => prismaBase.authRateLimit.findUnique({ where: { key } });
/** Ends a running cooldown (the DB clock can't be faked — the row is moved instead). */
const expireCooldown = (key: string) =>
  prismaBase.authRateLimit.update({ where: { key: `${key}:cool` }, data: { windowEnd: new Date(Date.now() - 1000) } });
async function seedCooldown(rule: { bucket: string; windowMs: number; free: number }, ...subject: string[]) {
  const key = keyOf(rule, ...subject);
  const counter = { count: rule.free + 1, windowEnd: new Date(Date.now() + rule.windowMs) };
  const cool = { count: 1, windowEnd: new Date(Date.now() + 10 * 60_000) };
  await prismaBase.authRateLimit.upsert({ where: { key }, create: { key, ...counter }, update: counter });
  await prismaBase.authRateLimit.upsert({ where: { key: `${key}:cool` }, create: { key: `${key}:cool`, ...cool }, update: cool });
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  setIp(IP);
});
afterEach(async () => {
  vi.restoreAllMocks();
  setIp(IP);
  await resetDb();
  mockCookieStore.clear();
});

describe("progressive cooldowns — bounded, never a lockout", () => {
  it("the schedule: 4 free attempts per address+IP, then 30 s, 1, 2, 5 min, capped at 15 min", () => {
    const r = PROGRESSIVE_LIMITS.loginEmailIp;
    expect(r.free).toBe(4);
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => progressiveCooldownMs(r, n) / 1000)).toEqual([30, 60, 120, 300, 900, 900, 900]);
    expect(Math.max(...PROGRESSIVE_LIMITS.loginEmail.cooldownsMs)).toBe(15 * 60_000);
    expect(formatRetryAfter(30_000)).toBe("30 secondes");
    expect(formatRetryAfter(1_000)).toBe("1 seconde");
    expect(formatRetryAfter(61_000)).toBe("2 minutes");
    expect(formatRetryAfter(59_900)).toBe("1 minute"); // never « 60 secondes »
  });

  it("each expired cooldown allows ONE attempt and starts the next, longer one", async () => {
    const user = await createTestUser({ email: "progress@test.local" });
    const key = keyOf(PROGRESSIVE_LIMITS.loginEmailIp, user.email, IP);
    for (let i = 0; i < 5; i += 1) expect(errorOf(await login(user.email, "wrong"))).toBe(INVALID);
    const first = await row(`${key}:cool`);
    expect(first!.windowEnd.getTime() - Date.now()).toBeGreaterThan(20_000);
    expect(first!.windowEnd.getTime() - Date.now()).toBeLessThanOrEqual(31_000);
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/Réessayez dans \d+ secondes?\.$/);

    await expireCooldown(key);
    expect(errorOf(await login(user.email, "wrong"))).toBe(INVALID); // one attempt
    const second = await row(`${key}:cool`);
    expect(second!.windowEnd.getTime() - Date.now()).toBeGreaterThan(50_000); // 1 min now
    expect(errorOf(await login(user.email, "wrong"))).toMatch(/^Trop de tentatives/); // and only one
    expect((await row(key))!.count).toBe(6); // refused attempts are not counted

    await expireCooldown(key);
    expect(succeeded(await login(user.email, PASSWORD))).toBe(true);
    expect(await row(key)).toBeNull();
    expect(await row(`${key}:cool`)).toBeNull();
  });

  it("concurrent guesses can't all slip through: exactly free + 1 run bcrypt", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const results = await Promise.all(Array.from({ length: 12 }, () => login("burst@test.local", "wrong")));
    expect(compare).toHaveBeenCalledTimes(PROGRESSIVE_LIMITS.loginEmailIp.free + 1);
    expect(results.filter((r) => errorOf(r) === INVALID)).toHaveLength(5);
    expect(results.filter((r) => errorOf(r)?.startsWith("Trop de tentatives"))).toHaveLength(7);
  });
});

describe("known device — the owner keeps access, the attacker gains nothing", () => {
  async function knownDeviceCookie(email: string) {
    expect(succeeded(await login(email, PASSWORD))).toBe(true);
    const value = mockCookieStore.get(KNOWN_DEVICE_COOKIE)?.value;
    expect(value).toBeTruthy();
    return value!;
  }

  it("a successful login issues a signed, expiring, address-bound cookie — and rotates it on the next one", async () => {
    const user = await createTestUser({ email: "owner@test.local" });
    const first = await knownDeviceCookie(user.email);
    const claim = parseKnownDevice(first)!;
    expect(claim.userId).toBe(user.id);
    expect(claim.emailTag).toBe(knownDeviceEmailTag("owner@test.local"));
    expect(first).not.toContain("owner@test.local"); // never the address itself
    expect(claim.exp * 1000 - Date.now()).toBeGreaterThan(KNOWN_DEVICE_TTL_MS - 60_000);
    expect(knownDeviceCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 3600 });

    const second = await knownDeviceCookie(user.email);
    expect(second).not.toBe(first);
    expect(parseKnownDevice(second)!.nonce).not.toBe(claim.nonce);
  });

  it("an attacker hammering the address slows unknown devices only — the owner's device still signs in", async () => {
    const user = await createTestUser({ email: "victim@test.local" });
    const cookie = await knownDeviceCookie(user.email);
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, "victim@test.local");

    mockCookieStore.clear();
    setIp("198.51.100.7");
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives/); // unknown device waits

    mockCookieStore.clear();
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(succeeded(await login(user.email, PASSWORD))).toBe(true); // the owner's browser
  });

  it("a tampered, foreign-address, expired or malformed cookie is ignored (no exemption)", async () => {
    const user = await createTestUser({ email: "target@test.local" });
    const real = await knownDeviceCookie(user.email);
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, "target@test.local");
    const claim = parseKnownDevice(real)!;
    const forged = [
      real.slice(0, -2) + (real.endsWith("AA") ? "BB" : "AA"), // bad signature
      signKnownDevice({ ...claim, emailTag: knownDeviceEmailTag("someone-else@test.local") }), // another address
      signKnownDevice({ ...claim, exp: Math.floor(Date.now() / 1000) - 1 }), // expired
      "kd1.a.b.c.d.e", // malformed
      "x".repeat(600), // oversized
    ];
    for (const value of forged) {
      mockCookieStore.clear();
      mockCookieStore.set(KNOWN_DEVICE_COOKIE, value);
      expect(errorOf(await login(user.email, PASSWORD)), value.slice(0, 20)).toMatch(/^Trop de tentatives/);
    }
    expect(parseKnownDevice(forged[2])).toBeNull();
  });

  it("the cookie is never an authentication: a wrong password still fails", async () => {
    const user = await createTestUser({ email: "noskip@test.local" });
    await knownDeviceCookie(user.email);
    expect(errorOf(await login(user.email, "wrong"))).toBe(INVALID);
  });

  it("a password change (reset) revokes every known device", async () => {
    const user = await createTestUser({ email: "revoked@test.local" });
    const cookie = await knownDeviceCookie(user.email);
    expect(parseKnownDevice(cookie)!.stamp).toBe(knownDevicePasswordStamp(user.passwordHash));
    await prismaBase.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash("another-pass-123", 4) } });
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, "revoked@test.local");
    mockCookieStore.clear();
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(errorOf(await login(user.email, "another-pass-123"))).toMatch(/^Trop de tentatives/);
  });

  it("a stolen cookie is held to its own device bucket", async () => {
    const user = await createTestUser({ email: "stolen@test.local" });
    const cookie = await knownDeviceCookie(user.email);
    const nonce = parseKnownDevice(cookie)!.nonce;
    await prismaBase.authRateLimit.create({
      data: { key: keyOf(RATE_LIMITS.loginDevice, nonce), count: RATE_LIMITS.loginDevice.limit, windowEnd: new Date(Date.now() + 600_000) },
    });
    setIp("203.0.113.50");
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives/);
  });

  it("« toutes les sessions » clears this device's cookie", async () => {
    const user = await createTestUser({ email: "logout-kd@test.local" });
    await knownDeviceCookie(user.email);
    mockCookieStore.delete("aec_session");
    await createSession(user.id);
    await settle(logoutAllSessionsAction());
    expect(mockCookieStore.get(KNOWN_DEVICE_COOKIE)).toBeUndefined();
  });
});

describe("password reset quotas — separate from login, and the owner's recovery survives abuse", () => {
  const request = (email: string) => requestPasswordResetAction(undefined, fd({ email }));

  it("an attacker exhausting the address's quota can't block the owner's known device", async () => {
    const user = await createTestUser({ email: "recover@test.local" });
    expect(succeeded(await login(user.email, PASSWORD))).toBe(true);
    const cookie = mockCookieStore.get(KNOWN_DEVICE_COOKIE)!.value;
    vi.spyOn(console, "log").mockImplementation(() => {});

    mockCookieStore.clear();
    setIp("198.51.100.66");
    for (let i = 0; i < 5; i += 1) await request(user.email); // attacker: 3 sent, 2 absorbed
    await flushAfterTasks();
    expect(await prismaBase.passwordResetToken.count({ where: { userId: user.id } })).toBe(3);

    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    setIp(IP);
    expect(await request(user.email)).toEqual({ ok: true, data: undefined });
    await flushAfterTasks();
    expect(await prismaBase.passwordResetToken.count({ where: { userId: user.id } })).toBe(4);
  });

  it("unknown devices also have a daily cap per address (silent)", async () => {
    const user = await createTestUser({ email: "daily@test.local" });
    await prismaBase.authRateLimit.create({
      data: {
        key: keyOf(RATE_LIMITS.resetRequestEmailDaily, "daily@test.local"),
        count: RATE_LIMITS.resetRequestEmailDaily.limit,
        windowEnd: new Date(Date.now() + 3_600_000),
      },
    });
    expect(await request(user.email)).toEqual({ ok: true, data: undefined });
    expect(await prismaBase.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it("reset requests never touch the login buckets", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createTestUser({ email: "separate@test.local" });
    await request("separate@test.local");
    expect(await row(keyOf(PROGRESSIVE_LIMITS.loginEmail, "separate@test.local"))).toBeNull();
    expect(await row(keyOf(PROGRESSIVE_LIMITS.loginEmailIp, "separate@test.local", IP))).toBeNull();
    expect(resetPasswordAction).toBeTypeOf("function");
  });
});

describe("client IP — only what the platform sets is trusted", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it("on Vercel: x-vercel-forwarded-for, else the platform-overwritten x-forwarded-for", () => {
    expect(clientIpFromHeaders(headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.2.3.4" }), true)).toBe("203.0.113.9");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }), true)).toBe("203.0.113.9");
  });

  it("elsewhere a client-forged first hop is ignored: x-real-ip, else the LAST x-forwarded-for hop", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), false)).toBe("203.0.113.9");
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9", "x-real-ip": "198.51.100.1" }), false)).toBe("198.51.100.1");
    // Rotating the forged part never changes the subject.
    const rotated = ["1.1.1.1", "2.2.2.2", "9.9.9.9"].map((f) => clientIpFromHeaders(headers({ "x-forwarded-for": `${f}, 203.0.113.9` }), false));
    expect(new Set(rotated)).toEqual(new Set(["203.0.113.9"]));
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "garbage" }), false)).toBeNull();
  });
});
