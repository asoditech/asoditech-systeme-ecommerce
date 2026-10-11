import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/lib/auth/password";
import { createSession, getCurrentUser } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/tokens";
import { PLATFORM_UNLOCK_COOKIE, hasPlatformUnlock, verifyPlatformKey } from "@/lib/auth/platform-access";
import { PROGRESSIVE_LIMITS, RATE_LIMITS, normalizeIp, rateLimitKey } from "@/lib/security/rate-limit";
import { loginAction, logoutAllSessionsAction } from "@/actions/auth";
import { requestPasswordResetAction, resetPasswordAction } from "@/actions/password-reset";
import { unlockPlatformAction } from "@/actions/platform-access";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { mockCookieStore, mockHeaders } from "../mocks/cookie-store";
import { RedirectSignal, flushAfterTasks } from "../setup";

/**
 * Batch 1A authentication hardening: rate limiting on login / password
 * reset / platform unlock, the N1–N3 fixes, and « Se déconnecter de toutes
 * les sessions ». Real test database, real bcrypt.
 */

const PASSWORD = "correct-horse-battery-staple"; // createTestUser's fixture password
const INVALID = "E-mail ou mot de passe incorrect.";
const IP = "127.0.0.1"; // tests/mocks/cookie-store.ts default x-forwarded-for

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
const login = (email: string, password: string) => settle(loginAction(undefined, fd({ email, password })));
const errorOf = (r: Awaited<ReturnType<typeof login>>) => (r.ok && !r.v.ok ? r.v.error : null);

type AnyRule = { bucket: string; windowMs: number };
async function bucket(rule: AnyRule, ...subject: string[]) {
  return prismaBase.authRateLimit.findUnique({ where: { key: rateLimitKey(rule, ...subject) } });
}
async function seedBucket(rule: AnyRule, count: number, ...subject: string[]) {
  await prismaBase.authRateLimit.create({
    data: { key: rateLimitKey(rule, ...subject), count, windowEnd: new Date(Date.now() + rule.windowMs) },
  });
}
/** A progressive bucket whose free attempts are used up and whose cooldown is running. */
async function seedCooldown(rule: AnyRule & { free: number }, ...subject: string[]) {
  await seedBucket(rule, rule.free + 1, ...subject);
  await prismaBase.authRateLimit.create({
    data: { key: `${rateLimitKey(rule, ...subject)}:cool`, count: 1, windowEnd: new Date(Date.now() + 10 * 60_000) },
  });
}
function setIp(ip: string) {
  mockHeaders.set("x-forwarded-for", ip);
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  setIp(IP);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setIp(IP);
  await resetDb();
  mockCookieStore.clear();
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("loginAction — rate limiting", () => {
  it("login:ip blocks before any account lookup or bcrypt, even with the right password", async () => {
    const user = await createTestUser({ email: "ip-limited@test.local" });
    await seedBucket(RATE_LIMITS.loginIp, RATE_LIMITS.loginIp.limit, IP);
    const compare = vi.spyOn(bcrypt, "compare");

    const res = await login(user.email, PASSWORD);
    expect(errorOf(res)).toMatch(/^Trop de tentatives de connexion\. Réessayez dans \d+ minutes?\.$/);
    expect(compare).not.toHaveBeenCalled();
    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("counts EVERY attempt per IP (success included) and allows exactly the limit", async () => {
    await seedBucket(RATE_LIMITS.loginIp, RATE_LIMITS.loginIp.limit - 1, IP);
    const user = await createTestUser({ email: "ip-edge@test.local" });
    expect((await login(user.email, PASSWORD)).ok).toBe(false); // RedirectSignal: the 40th attempt succeeds
    expect((await bucket(RATE_LIMITS.loginIp, IP))?.count).toBe(RATE_LIMITS.loginIp.limit);
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives/);
  });

  it("login:email_ip: after 5 failures the correct password is refused without bcrypt (cooldown running)", async () => {
    const user = await createTestUser({ email: "guessed@test.local" });
    // 4 free attempts, the 5th runs and starts the first cooldown.
    for (let i = 0; i < PROGRESSIVE_LIMITS.loginEmailIp.free + 1; i += 1) {
      expect(errorOf(await login(user.email, `wrong-${i}`))).toBe(INVALID);
    }
    const compare = vi.spyOn(bcrypt, "compare");
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives de connexion/);
    expect(compare).not.toHaveBeenCalled();
    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(0);

    // Another IP is not affected by this pair's bucket.
    setIp("198.51.100.20");
    expect((await login(user.email, PASSWORD)).ok).toBe(false); // RedirectSignal = success
    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("mixed-case emails share the same buckets", async () => {
    const user = await createTestUser({ email: "case@test.local" });
    for (const variant of ["CASE@test.local", "Case@Test.Local", "case@TEST.local", "cAsE@test.local", "case@test.LOCAL"]) {
      await login(variant, "wrong");
    }
    expect((await bucket(PROGRESSIVE_LIMITS.loginEmailIp, "case@test.local", IP))?.count).toBe(5);
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives/);
  });

  it("login:email slows distributed guessing: past the free attempts, every unknown device waits", async () => {
    const user = await createTestUser({ email: "sprayed@test.local" });
    await seedBucket(PROGRESSIVE_LIMITS.loginEmail, PROGRESSIVE_LIMITS.loginEmail.free, "sprayed@test.local");
    setIp("203.0.113.1");
    expect(errorOf(await login(user.email, "wrong"))).toBe(INVALID); // runs, starts the cooldown
    setIp("203.0.113.99"); // a fresh IP, with the right password
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives de connexion\. Réessayez dans 1 minute\.$/);
  });

  it("a successful login clears login:email_ip only — login:email is kept", async () => {
    const user = await createTestUser({ email: "recovering@test.local" });
    for (let i = 0; i < 3; i += 1) await login(user.email, "wrong");
    expect((await login(user.email, PASSWORD)).ok).toBe(false); // RedirectSignal = success
    expect(await bucket(PROGRESSIVE_LIMITS.loginEmailIp, user.email, IP)).toBeNull();
    // The successful attempt itself is given back; the 3 failures stay.
    expect((await bucket(PROGRESSIVE_LIMITS.loginEmail, user.email))?.count).toBe(3);
  });

  it("blocks an unknown email exactly like an existing one (no enumeration through the limiter)", async () => {
    await createTestUser({ email: "exists@test.local" });
    for (let i = 0; i < 5; i += 1) {
      await login("exists@test.local", "wrong");
      await login("nobody@test.local", "wrong");
    }
    const a = errorOf(await login("exists@test.local", "wrong"));
    const b = errorOf(await login("nobody@test.local", "wrong"));
    expect(a).toMatch(/^Trop de tentatives/);
    // Same message (the remaining seconds may tick between the two calls).
    const shape = (m: string | null) => m?.replace(/\d+/g, "N");
    expect(shape(a)).toBe(shape(b));
  }, 20_000); // 10 real cost-12 bcrypt comparisons

  it("keeps the generic failure message unchanged", async () => {
    await createTestUser({ email: "generic@test.local" });
    expect(errorOf(await login("generic@test.local", "wrong"))).toBe(INVALID);
    expect(errorOf(await login("nobody@test.local", "wrong"))).toBe(INVALID);
  });

  it("fails open when the limiter backend errors: login still works, nothing sensitive logged", async () => {
    const user = await createTestUser({ email: "failopen@test.local" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prismaBase, "$queryRaw").mockRejectedValue(new Error("relation does not exist"));
    vi.spyOn(prismaBase, "$executeRaw").mockRejectedValue(new Error("relation does not exist"));
    expect((await login(user.email, PASSWORD)).ok).toBe(false); // RedirectSignal = success
    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(1);
    expect(error).toHaveBeenCalledWith("[rate-limit] backend_error", expect.any(Object));
    expect(JSON.stringify(error.mock.calls)).not.toContain(user.email);
    expect(JSON.stringify(error.mock.calls)).not.toContain(IP);
  });
});

describe("loginAction — N1 dummy bcrypt", () => {
  it("an unknown email still runs one bcrypt comparison, against the constant dummy hash", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    expect(errorOf(await login("nobody@test.local", "whatever"))).toBe(INVALID);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]![1]).toBe(DUMMY_PASSWORD_HASH);
  });

  it("a disabled account (no hash actually checked) also burns the dummy comparison", async () => {
    await createTestUser({ email: "disabled-n1@test.local", status: "DISABLED" });
    const compare = vi.spyOn(bcrypt, "compare");
    await login("disabled-n1@test.local", PASSWORD);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]![1]).toBe(DUMMY_PASSWORD_HASH);
  });

  it("a real account compares against its own hash only, never the dummy", async () => {
    const user = await createTestUser({ email: "real-n1@test.local" });
    const compare = vi.spyOn(bcrypt, "compare");
    await login(user.email, "wrong");
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]![1]).toBe(user.passwordHash);
  });

  it("the dummy hash is a constant bcrypt hash at the real cost (12) that matches nothing", async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(12);
    expect(await verifyPassword("", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword(PASSWORD, DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Password reset request
// ---------------------------------------------------------------------------

describe("requestPasswordResetAction — rate limiting and N2", () => {
  const request = (email: string) => requestPasswordResetAction(undefined, fd({ email }));

  it("reset_req:ip returns a generic rate-limit error past 10 requests", async () => {
    for (let i = 0; i < RATE_LIMITS.resetRequestIp.limit; i += 1) {
      expect(await request(`someone-${i}@test.local`)).toEqual({ ok: true, data: undefined });
    }
    const blocked = await request("one-more@test.local");
    expect(blocked).toMatchObject({ ok: false, error: "Trop de demandes de réinitialisation. Réessayez plus tard." });
  });

  it("reset_req:email: beyond 3 requests the response stays the generic success and no email is sent", async () => {
    const user = await createTestUser({ email: "flooded@test.local" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const responses = [];
    for (let i = 0; i < 5; i += 1) responses.push(await request("flooded@test.local"));
    await flushAfterTasks();
    for (const r of responses) expect(r).toEqual({ ok: true, data: undefined });
    expect(await prismaBase.passwordResetToken.count({ where: { userId: user.id } })).toBe(3);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("/reinitialiser-mot-de-passe/"))).toHaveLength(3);
  });

  it("reset_req:email: mixed-case requests count toward the same bucket", async () => {
    const user = await createTestUser({ email: "mixed@test.local" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The account lookup itself stays exact-match (unchanged), but the bucket is shared:
    await request("Mixed@Test.local");
    await request("MIXED@test.local");
    expect(await request("mixed@test.local")).toEqual({ ok: true, data: undefined }); // 3rd hit: still sent
    expect(await request("mixed@test.local")).toEqual({ ok: true, data: undefined }); // 4th hit: absorbed
    await flushAfterTasks();
    expect((await bucket(RATE_LIMITS.resetRequestEmail, "mixed@test.local"))?.count).toBe(4);
    expect(await prismaBase.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
  });

  it("an exceeded email bucket is indistinguishable for an existing and an unknown address", async () => {
    await createTestUser({ email: "known-n2@test.local" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const known = [];
    const unknown = [];
    for (let i = 0; i < 4; i += 1) {
      known.push(await request("known-n2@test.local"));
      unknown.push(await request("unknown-n2@test.local"));
    }
    expect(known).toEqual(unknown);
    expect(known.every((r) => r.ok)).toBe(true);
  });

  it("N2: the email is handed to after() (sent after the response); token and audit are written first", async () => {
    const user = await createTestUser({ email: "after@test.local" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await request(user.email)).toEqual({ ok: true, data: undefined });
    expect(await prismaBase.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
    expect(await prismaBase.auditEvent.count({ where: { action: "password_reset.requested", entityId: user.id } })).toBe(1);
    await flushAfterTasks();
    expect(log.mock.calls.some((c) => String(c[0]).includes("/reinitialiser-mot-de-passe/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Password reset confirmation
// ---------------------------------------------------------------------------

describe("resetPasswordAction — flood protection and N3", () => {
  async function requestReset(email: string) {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await requestPasswordResetAction(undefined, fd({ email }));
    await flushAfterTasks();
    const call = log.mock.calls.find((args) => String(args[0]).includes("/reinitialiser-mot-de-passe/"));
    log.mockRestore();
    const match = String(call?.[0] ?? "").match(/\/reinitialiser-mot-de-passe\/(\S+)/);
    if (!match) throw new Error("no reset link logged");
    return match[1]!;
  }
  const confirm = (token: string, password = "brand-new-password-1") =>
    settle(resetPasswordAction(undefined, fd({ token, password })));

  it("reset_confirm:ip refuses the 21st attempt in the window", async () => {
    for (let i = 0; i < RATE_LIMITS.resetConfirmIp.limit; i += 1) {
      const r = await confirm(`not-a-real-token-${i}`);
      expect(r.ok && r.v).toMatchObject({ ok: false, error: "Ce lien de réinitialisation n'est plus valide." });
    }
    const blocked = await confirm("not-a-real-token-x");
    expect(blocked.ok && blocked.v).toMatchObject({ ok: false, error: "Trop de tentatives. Réessayez plus tard." });
  });

  it("a successful reset retires every other usable link, leaves used/expired ones as they were, and revokes sessions", async () => {
    const user = await createTestUser({ email: "siblings@test.local" });
    await createSession(user.id);
    await createSession(user.id);
    const first = await requestReset(user.email);
    const second = await requestReset(user.email);
    const third = await requestReset(user.email);

    // Pre-existing history: one expired-unused, one already used.
    const expired = await prismaBase.passwordResetToken.create({
      data: { tenantId: DEFAULT_TENANT_ID, userId: user.id, tokenHash: "expired-hash", expiresAt: new Date(Date.now() - 60_000) },
    });
    const usedAt = new Date(Date.now() - 30 * 60_000);
    const used = await prismaBase.passwordResetToken.create({
      data: { tenantId: DEFAULT_TENANT_ID, userId: user.id, tokenHash: "used-hash", expiresAt: new Date(Date.now() + 60_000), usedAt },
    });

    const done = await confirm(second);
    expect(done.ok).toBe(false);
    expect((done as { e: unknown }).e).toBeInstanceOf(RedirectSignal);

    const byHash = (raw: string) => prismaBase.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(raw) } });
    for (const raw of [first, second, third]) expect((await byHash(raw)).usedAt).not.toBeNull();
    expect((await prismaBase.passwordResetToken.findUniqueOrThrow({ where: { id: expired.id } })).usedAt).toBeNull();
    expect((await prismaBase.passwordResetToken.findUniqueOrThrow({ where: { id: used.id } })).usedAt).toEqual(usedAt);

    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(0);
    const row = await prismaBase.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("brand-new-password-1", row.passwordHash)).toBe(true);

    // An older link can no longer set a password.
    const stale = await confirm(first, "attacker-password-9");
    expect(stale.ok && stale.v).toMatchObject({ ok: false });
    const after = await prismaBase.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("attacker-password-9", after.passwordHash)).toBe(false);
    expect(await prismaBase.auditEvent.count({ where: { action: "password_reset.completed", entityId: user.id } })).toBe(1);
  });

  it("a completed reset lifts the login:email and address+IP cooldowns for that address", async () => {
    const user = await createTestUser({ email: "locked-out@test.local" });
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmail, "locked-out@test.local");
    await seedCooldown(PROGRESSIVE_LIMITS.loginEmailIp, "locked-out@test.local", IP);
    expect(errorOf(await login(user.email, PASSWORD))).toMatch(/^Trop de tentatives/);

    const token = await requestReset(user.email);
    await confirm(token, "brand-new-password-2");
    expect(await bucket(PROGRESSIVE_LIMITS.loginEmail, "locked-out@test.local")).toBeNull();
    expect(await bucket(PROGRESSIVE_LIMITS.loginEmailIp, "locked-out@test.local", IP)).toBeNull();
    expect((await login(user.email, "brand-new-password-2")).ok).toBe(false); // RedirectSignal = success
  });
});

// ---------------------------------------------------------------------------
// Platform unlock
// ---------------------------------------------------------------------------

describe("unlockPlatformAction — rate limiting", () => {
  const KEY = "platform-key-batch1a-" + "z".repeat(40);
  const KEY_SHA = createHash("sha256").update(KEY).digest("hex");
  const unlock = (key: string) => settle(unlockPlatformAction(undefined, fd({ key })));

  async function signedInPlatformAdmin() {
    const admin = await createTestUser({ role: "OWNER", isPlatformAdmin: true });
    mockCookieStore.clear();
    await createSession(admin.id);
    return admin;
  }

  it("after 5 failures even the right key is refused, audited as rate-limited, and nothing unlocks", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const admin = await signedInPlatformAdmin();
    for (let i = 0; i < RATE_LIMITS.unlockUser.limit; i += 1) {
      const r = await unlock(`wrong-${i}`);
      expect(r.ok && r.v).toMatchObject({ ok: false, error: "Clé d'accès invalide." });
    }
    const blocked = await unlock(KEY);
    expect(blocked.ok && blocked.v).toMatchObject({ ok: false });
    expect(blocked.ok && !blocked.v.ok && blocked.v.error).toMatch(/^Trop de tentatives\. Réessayez dans \d+ minutes?\.$/);
    expect(mockCookieStore.get(PLATFORM_UNLOCK_COOKIE)).toBeUndefined();
    expect(await hasPlatformUnlock(admin.id)).toBe(false);
    const limited = await prismaBase.auditEvent.findMany({ where: { action: "platform.unlock.failure", entityId: admin.id } });
    expect(limited).toHaveLength(6);
    expect(limited.filter((e) => (e.metadata as { reason?: string } | null)?.reason === "rate_limited")).toHaveLength(1);
  });

  it("the daily bucket blocks too", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const admin = await signedInPlatformAdmin();
    await seedBucket(RATE_LIMITS.unlockUserDaily, RATE_LIMITS.unlockUserDaily.limit, admin.id);
    const r = await unlock(KEY);
    expect(r.ok && r.v).toMatchObject({ ok: false });
    expect(mockCookieStore.get(PLATFORM_UNLOCK_COOKIE)).toBeUndefined();
  });

  it("fails CLOSED when the limiter cannot be evaluated: the right key does not unlock", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const admin = await signedInPlatformAdmin();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prismaBase, "$queryRaw").mockRejectedValue(new Error("db down"));
    const r = await unlock(KEY);
    expect(r.ok && r.v).toMatchObject({ ok: false, error: "Accès plateforme temporairement indisponible. Réessayez plus tard." });
    expect(mockCookieStore.get(PLATFORM_UNLOCK_COOKIE)).toBeUndefined();
    const event = await prismaBase.auditEvent.findFirstOrThrow({ where: { action: "platform.unlock.failure", entityId: admin.id } });
    expect(event.metadata).toEqual({ reason: "limiter_unavailable" });
  });

  it("under the limit the unchanged constant-time verification still unlocks with the right key only", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", KEY_SHA);
    const admin = await signedInPlatformAdmin();
    expect(verifyPlatformKey(KEY)).toBe(true);
    expect(verifyPlatformKey(KEY + "x")).toBe(false);
    expect(verifyPlatformKey("")).toBe(false);
    await unlock("wrong");
    const ok = await unlock(KEY);
    expect((ok as { e: unknown }).e).toBeInstanceOf(RedirectSignal);
    expect(await hasPlatformUnlock(admin.id)).toBe(true);
    expect((await bucket(RATE_LIMITS.unlockUser, admin.id))?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Log out all sessions
// ---------------------------------------------------------------------------

describe("logoutAllSessionsAction", () => {
  it("requires an authenticated session", async () => {
    await expect(logoutAllSessionsAction()).rejects.toThrow(/Non autorisé/);
  });

  it("removes every session of the user (current one included), audits, clears the platform unlock, redirects to /connexion", async () => {
    vi.stubEnv("PLATFORM_ACCESS_KEY_SHA256", createHash("sha256").update("k".repeat(48)).digest("hex"));
    const user = await createTestUser({ role: "OWNER", isPlatformAdmin: true });
    const other = await createTestUser({ email: "colleague@test.local" });
    await createSession(other.id);
    await createSession(user.id); // "another device"
    await createSession(user.id); // another device
    mockCookieStore.clear();
    await createSession(user.id); // the current session (cookie set)
    mockCookieStore.set(PLATFORM_UNLOCK_COOKIE, "123.abc");
    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(3);

    const r = await settle(logoutAllSessionsAction());
    expect((r as { e: RedirectSignal }).e).toBeInstanceOf(RedirectSignal);
    expect((r as { e: RedirectSignal }).e.url).toBe("/connexion");

    expect(await prismaBase.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prismaBase.session.count({ where: { userId: other.id } })).toBe(1);
    expect(mockCookieStore.get("aec_session")).toBeUndefined();
    expect(mockCookieStore.get(PLATFORM_UNLOCK_COOKIE)).toBeUndefined();
    expect(await getCurrentUser()).toBeNull();

    const event = await prismaBase.auditEvent.findFirstOrThrow({ where: { action: "user.sessions_revoked_all" } });
    expect(event).toMatchObject({ tenantId: DEFAULT_TENANT_ID, actorUserId: user.id, entityId: user.id, actorType: "USER" });
    expect(event.metadata).toEqual({ revokedSessions: 3 });

    const tenant = await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } });
    expect(tenant.status).toBe("ACTIVE");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("ACTIVE");
  });
});

it("normalizeIp keeps the mocked loopback as-is (sanity for the keys above)", () => {
  expect(normalizeIp(IP)).toBe(IP);
});
