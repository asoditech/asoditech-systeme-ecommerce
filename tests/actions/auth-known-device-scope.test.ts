import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { createSession, destroyAllSessionsForUser, getCurrentUser } from "@/lib/auth/session";
import { PROGRESSIVE_LIMITS, RATE_LIMITS, rateLimitKey } from "@/lib/security/rate-limit";
import { KNOWN_DEVICE_COOKIE, parseKnownDevice } from "@/lib/security/known-device";
import { loginAction } from "@/actions/auth";
import { requestPasswordResetAction } from "@/actions/password-reset";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { mockCookieStore, mockHeaders } from "../mocks/cookie-store";
import { flushAfterTasks } from "../setup";

/**
 * The known-device exemption is scoped to the device's OWN user. Email is
 * unique per tenant, not globally (docs/adr/0025): a same-address account in
 * another tenant — e.g. one an attacker created in their own tenant — must
 * not turn the victim's address-wide login / reset quotas into per-IP ones.
 * Plus: a sliding session refresh racing « toutes les sessions » never
 * throws. Real test database, real bcrypt.
 */

const PASSWORD = "correct-horse-battery-staple"; // createTestUser's fixture password
const ATTACKER_PASSWORD = "attacker-own-password-1";
const INVALID = "E-mail ou mot de passe incorrect.";
const IP = "127.0.0.1";
const SHARED = "shared-kd@test.local";
const TENANT_B = "tenant-b-known-device";

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
const requestReset = (email: string) => requestPasswordResetAction(undefined, fd({ email }));

type AnyRule = { bucket: string; windowMs: number };
const bucket = (rule: AnyRule, ...subject: string[]) =>
  prismaBase.authRateLimit.findUnique({ where: { key: rateLimitKey(rule, ...subject) } });
async function seedCooldown(rule: AnyRule & { free: number }, ...subject: string[]) {
  const key = rateLimitKey(rule, ...subject);
  await prismaBase.authRateLimit.upsert({
    where: { key },
    create: { key, count: rule.free + 1, windowEnd: new Date(Date.now() + rule.windowMs) },
    update: { count: rule.free + 1, windowEnd: new Date(Date.now() + rule.windowMs) },
  });
  await prismaBase.authRateLimit.upsert({
    where: { key: `${key}:cool` },
    create: { key: `${key}:cool`, count: 1, windowEnd: new Date(Date.now() + 10 * 60_000) },
    update: { count: 1, windowEnd: new Date(Date.now() + 10 * 60_000) },
  });
}

/** Victim in the bootstrap tenant, attacker-controlled same-address account in tenant B. */
async function sameAddressInTwoTenants() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
  const victim = await createTestUser({ email: SHARED, tenantId: DEFAULT_TENANT_ID });
  const attacker = await prismaBase.user.create({
    data: {
      tenantId: TENANT_B,
      email: SHARED,
      name: "Attacker",
      passwordHash: await hashPassword(ATTACKER_PASSWORD),
      role: "OWNER",
      status: "ACTIVE",
    },
  });
  return { victim, attacker };
}

/** Signs in from a fresh browser and returns the known-device cookie it received. */
async function deviceCookieFor(email: string, password: string) {
  mockCookieStore.clear();
  expect(succeeded(await login(email, password))).toBe(true);
  const value = mockCookieStore.get(KNOWN_DEVICE_COOKIE)?.value;
  expect(value).toBeTruthy();
  mockCookieStore.clear();
  return value!;
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

describe("login — the known-device exemption covers the device's own user only", () => {
  it("a same-address account's device in ANOTHER tenant is charged to the victim's login:email bucket", async () => {
    const { attacker } = await sameAddressInTwoTenants();
    const cookie = await deviceCookieFor(SHARED, ATTACKER_PASSWORD);
    expect(parseKnownDevice(cookie)!.userId).toBe(attacker.id);
    const before = (await bucket(PROGRESSIVE_LIMITS.loginEmail, SHARED))?.count ?? 0;

    setIp("198.51.100.20");
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(errorOf(await login(SHARED, "a-guess-at-the-victim"))).toBe(INVALID);
    expect((await bucket(PROGRESSIVE_LIMITS.loginEmail, SHARED))?.count).toBe(before + 1);
  });

  it("once the victim's address is cooling down, the attacker's own valid device can't keep guessing — even the right password is refused", async () => {
    const { victim } = await sameAddressInTwoTenants();
    const cookie = await deviceCookieFor(SHARED, ATTACKER_PASSWORD);
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, SHARED);

    setIp("198.51.100.21");
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(errorOf(await login(SHARED, PASSWORD))).toMatch(/^Trop de tentatives/); // the victim's real password
    expect(await prismaBase.session.count({ where: { userId: victim.id } })).toBe(0);

    // An unknown device waits too.
    mockCookieStore.clear();
    setIp("198.51.100.22");
    expect(errorOf(await login(SHARED, PASSWORD))).toMatch(/^Trop de tentatives/);
  });

  it("the legitimate owner's known device still bypasses the cooled-down address (both tenants)", async () => {
    const { victim, attacker } = await sameAddressInTwoTenants();
    const victimCookie = await deviceCookieFor(SHARED, PASSWORD);
    const attackerCookie = await deviceCookieFor(SHARED, ATTACKER_PASSWORD);
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, SHARED);

    setIp("198.51.100.23");
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, victimCookie);
    expect(succeeded(await login(SHARED, PASSWORD))).toBe(true);
    expect(await prismaBase.session.count({ where: { userId: victim.id } })).toBeGreaterThan(0);

    mockCookieStore.clear();
    setIp("198.51.100.24");
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, attackerCookie);
    expect(succeeded(await login(SHARED, ATTACKER_PASSWORD))).toBe(true); // its OWN account, still exempt
    expect(await prismaBase.session.count({ where: { userId: attacker.id } })).toBeGreaterThan(0);
  });

  it("a mistyped password on the owner's own device counts against the address like any other attempt", async () => {
    const user = await createTestUser({ email: "typo-kd@test.local" });
    const cookie = await deviceCookieFor(user.email, PASSWORD);
    const before = (await bucket(PROGRESSIVE_LIMITS.loginEmail, user.email))?.count ?? 0;
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(errorOf(await login(user.email, "wrong-password"))).toBe(INVALID);
    expect((await bucket(PROGRESSIVE_LIMITS.loginEmail, user.email))?.count).toBe(before + 1);
    // …and the right one, from the same device, still gets through a cooldown.
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, user.email);
    expect(succeeded(await login(user.email, PASSWORD))).toBe(true);
  });
});

describe("password reset — the device quota covers the device's own, still-valid user only", () => {
  it("a disabled user's device cookie is charged to the address quota (no device exemption)", async () => {
    const user = await createTestUser({ email: "disabled-kd@test.local" });
    const cookie = await deviceCookieFor(user.email, PASSWORD);
    await prismaBase.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });

    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(await requestReset(user.email)).toEqual({ ok: true, data: undefined });
    expect((await bucket(RATE_LIMITS.resetRequestEmail, user.email))?.count).toBe(1);
    expect(await bucket(RATE_LIMITS.resetRequestDevice, parseKnownDevice(cookie)!.nonce)).toBeNull();
  });

  it("another tenant's same-address device can't mail the victim beyond the address quota", async () => {
    const { victim, attacker } = await sameAddressInTwoTenants();
    const cookie = await deviceCookieFor(SHARED, ATTACKER_PASSWORD);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await prismaBase.authRateLimit.create({
      data: {
        key: rateLimitKey(RATE_LIMITS.resetRequestEmail, SHARED),
        count: RATE_LIMITS.resetRequestEmail.limit,
        windowEnd: new Date(Date.now() + RATE_LIMITS.resetRequestEmail.windowMs),
      },
    });

    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    expect(await requestReset(SHARED)).toEqual({ ok: true, data: undefined });
    await flushAfterTasks();
    expect(await prismaBase.passwordResetToken.count({ where: { userId: victim.id } })).toBe(0);
    // The device's own account is still served under its device quota.
    expect(await prismaBase.passwordResetToken.count({ where: { userId: attacker.id } })).toBe(1);
  });

  it("a device whose password changed since is charged to the address quota", async () => {
    const user = await createTestUser({ email: "stale-kd@test.local" });
    const cookie = await deviceCookieFor(user.email, PASSWORD);
    await prismaBase.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword("a-new-password-123") } });

    vi.spyOn(console, "log").mockImplementation(() => {});
    mockCookieStore.set(KNOWN_DEVICE_COOKIE, cookie);
    await requestReset(user.email);
    await flushAfterTasks();
    expect((await bucket(RATE_LIMITS.resetRequestEmail, user.email))?.count).toBe(1);
    expect(await bucket(RATE_LIMITS.resetRequestDevice, parseKnownDevice(cookie)!.nonce)).toBeNull();
  });
});

describe("sliding session refresh racing « toutes les sessions »", () => {
  it("a session deleted between the read and the refresh resolves as signed out — no P2025", async () => {
    const user = await createTestUser({ email: "race-session@test.local" });
    await createSession(user.id);
    await prismaBase.session.updateMany({
      where: { userId: user.id },
      data: { lastUsedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }, // due for a refresh
    });

    const delegate = prismaBase.session;
    expect(prismaBase.session).toBe(delegate); // the spy below must land on the delegate session.ts uses
    const original = delegate.findUnique.bind(delegate);
    const spy = vi.spyOn(delegate, "findUnique").mockImplementation((async (args: Parameters<typeof original>[0]) => {
      const row = await original(args);
      await destroyAllSessionsForUser(user.id); // logout-all lands right after the read
      return row;
    }) as never);

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(spy).toHaveBeenCalled();
    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("records the trusted client IP, not a client-forged first x-forwarded-for hop", async () => {
    const user = await createTestUser({ email: "session-ip@test.local" });
    setIp("6.6.6.6, 203.0.113.9"); // first hop forged by the client, last appended by the proxy
    await createSession(user.id);
    const session = await prismaBase.session.findFirst({ where: { userId: user.id } });
    expect(session?.ipAddress).toBe("203.0.113.9");
  });
});
