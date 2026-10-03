import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The user's OWN WhatsApp number / verification / opt-in, and the tenant
 * switch — docs/adr/0058. Meta is mocked: no network.
 */

const meta = vi.hoisted(() => ({
  configured: true,
  sendTemplateMessage: vi.fn<(to: string, message: unknown) => Promise<{ ok: boolean; messageId?: string; error?: string }>>(async () => ({ ok: true, messageId: "wamid.test" })),
  checkWhatsAppSender: vi.fn(async (): Promise<{ ok: true; displayPhoneNumber: string | null; verifiedName: string | null } | { ok: false; error: string }> => ({
    ok: true,
    displayPhoneNumber: "+212 5 00 00 00 00",
    verifiedName: "ASODITECH",
  })),
}));
vi.mock("@/lib/whatsapp/client", () => ({
  isWhatsAppConfigured: () => meta.configured,
  sendTemplateMessage: meta.sendTemplateMessage,
  sendTemplate: vi.fn(),
  checkWhatsAppSender: meta.checkWhatsAppSender,
}));

import { prisma, prismaBase } from "@/lib/prisma";
import {
  removeMyWhatsAppNumberAction,
  requestMyWhatsAppVerificationAction,
  saveMyWhatsAppNumberAction,
  setMyWhatsAppOptInAction,
  testWhatsAppConnectionAction,
  verifyMyWhatsAppCodeAction,
} from "@/actions/whatsapp";
import { normalizeStaffWhatsAppPhone } from "@/lib/whatsapp/phone";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const own = (id: string) =>
  prismaBase.user.findUniqueOrThrow({
    where: { id },
    select: { whatsappPhone: true, whatsappVerifiedAt: true, whatsappOptInAt: true, whatsappVerification: true },
  });
/** The code the mocked provider was asked to send. */
const lastCode = () => {
  const call = meta.sendTemplateMessage.mock.calls.at(-1) as [string, { templateName: string; parameters: string[] }];
  expect(call[1].templateName).toBe("asoditech_verification_code");
  return call[1].parameters[0];
};

beforeEach(async () => {
  await resetDb();
  meta.configured = true;
  meta.sendTemplateMessage.mockClear();
  meta.checkWhatsAppSender.mockClear();
});
afterEach(async () => {
  await resetDb();
});

const enableTenant = () => prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });

describe("phone normalization (reuses the Moroccan rule)", () => {
  it("accepts local / international Moroccan mobiles and explicit international numbers; rejects the rest", () => {
    for (const raw of ["0612345678", "06 12 34 56 78", "+212 6 12 34 56 78", "00212612345678", "212612345678", "612345678"]) {
      expect(normalizeStaffWhatsAppPhone(raw)).toBe("212612345678");
    }
    expect(normalizeStaffWhatsAppPhone("0712345678")).toBe("212712345678");
    expect(normalizeStaffWhatsAppPhone("+33 6 12 34 56 78")).toBe("33612345678");
    for (const raw of ["", "123", "abc0612345678", "0512345678", "21261234567", "+0 612", "06123456789012345"]) {
      expect(normalizeStaffWhatsAppPhone(raw)).toBeNull();
    }
  });
});

describe("own number, verification, opt-in", () => {
  it("full flow: save → request code → wrong code → right code → opt in → opt out", async () => {
    await enableTenant();
    const me = await loginAsTestUser({ role: "WAREHOUSE" });

    expect((await saveMyWhatsAppNumberAction(fd({ phone: "06 12 34 56 78" }))).ok).toBe(true);
    expect(await own(me.id)).toMatchObject({ whatsappPhone: "212612345678", whatsappVerifiedAt: null, whatsappOptInAt: null });

    // Unverified → cannot opt in.
    expect((await setMyWhatsAppOptInAction(true)).ok).toBe(false);

    expect((await requestMyWhatsAppVerificationAction()).ok).toBe(true);
    expect(meta.sendTemplateMessage.mock.calls.at(-1)?.[0]).toBe("212612345678"); // the user's own number
    const code = lastCode();
    expect(JSON.stringify((await own(me.id)).whatsappVerification)).not.toContain(code); // only a hash is stored

    const wrong = code === "000000" ? "111111" : "000000";
    expect((await verifyMyWhatsAppCodeAction(fd({ code: wrong }))).ok).toBe(false);
    expect((await verifyMyWhatsAppCodeAction(fd({ code }))).ok).toBe(true);
    expect((await own(me.id)).whatsappVerifiedAt).not.toBeNull();

    expect((await setMyWhatsAppOptInAction(true)).ok).toBe(true);
    expect((await own(me.id)).whatsappOptInAt).not.toBeNull();
    expect((await setMyWhatsAppOptInAction(false)).ok).toBe(true);
    expect((await own(me.id)).whatsappOptInAt).toBeNull();
  });

  it("invalid number rejected; changing the number resets verification and opt-in", async () => {
    const me = await loginAsTestUser({ role: "MANAGER" });
    const bad = await saveMyWhatsAppNumberAction(fd({ phone: "12345" }));
    expect(bad.ok).toBe(false);
    expect((await own(me.id)).whatsappPhone).toBeNull();

    await prismaBase.user.update({ where: { id: me.id }, data: { whatsappPhone: "212612345678", whatsappVerifiedAt: new Date(), whatsappOptInAt: new Date() } });
    await saveMyWhatsAppNumberAction(fd({ phone: "0700000001" }));
    expect(await own(me.id)).toMatchObject({ whatsappPhone: "212700000001", whatsappVerifiedAt: null, whatsappOptInAt: null });

    await removeMyWhatsAppNumberAction();
    expect(await own(me.id)).toMatchObject({ whatsappPhone: null, whatsappVerifiedAt: null, whatsappOptInAt: null });
  });

  it("only ever touches the session user — a smuggled userId is ignored, even for an admin", async () => {
    const other = await createTestUser({ role: "WAREHOUSE" });
    await loginAsTestUser({ role: "ADMIN" });
    await saveMyWhatsAppNumberAction(fd({ phone: "0612345678", userId: other.id }));
    await setMyWhatsAppOptInAction(true);
    expect(await own(other.id)).toMatchObject({ whatsappPhone: null, whatsappOptInAt: null });
  });

  it("verification requires the tenant switch; codes are rate-limited, expire and lock after 5 wrong attempts", async () => {
    const me = await loginAsTestUser({ role: "WAREHOUSE" });
    await saveMyWhatsAppNumberAction(fd({ phone: "0612345678" }));
    expect((await requestMyWhatsAppVerificationAction()).ok).toBe(false); // WhatsApp not enabled for the tenant
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();

    await enableTenant();
    expect((await requestMyWhatsAppVerificationAction()).ok).toBe(true);
    expect((await requestMyWhatsAppVerificationAction()).ok).toBe(false); // 60 s cooldown
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verifyMyWhatsAppCodeAction(fd({ code: wrong }));
    const locked = await verifyMyWhatsAppCodeAction(fd({ code }));
    expect(locked.ok).toBe(false); // even the right code, after 5 failures
    expect((await own(me.id)).whatsappVerifiedAt).toBeNull();

    // An expired code is refused.
    const v = (await own(me.id)).whatsappVerification as Record<string, unknown>;
    await prismaBase.user.update({ where: { id: me.id }, data: { whatsappVerification: { ...v, attempts: 0, expiresAt: new Date(Date.now() - 1000).toISOString() } } });
    expect((await verifyMyWhatsAppCodeAction(fd({ code }))).ok).toBe(false);
    expect((await own(me.id)).whatsappVerifiedAt).toBeNull();
  });

  it("a failed code send is reported and does not verify anything", async () => {
    await enableTenant();
    const me = await loginAsTestUser({ role: "WAREHOUSE" });
    await saveMyWhatsAppNumberAction(fd({ phone: "0612345678" }));
    meta.sendTemplateMessage.mockResolvedValueOnce({ ok: false, error: "HTTP 400" } as never);
    expect((await requestMyWhatsAppVerificationAction()).ok).toBe(false);
    expect((await own(me.id)).whatsappVerifiedAt).toBeNull();
  });
});

describe("tenant switch (« Activer » / « Tester la connexion »)", () => {
  it("success enables (CONNECTE) without sending any message; failure → ERREUR + integration-error notification", async () => {
    const admin = await loginAsTestUser({ role: "OWNER" });
    const watcher = await createTestUser({ role: "ADMIN" });

    expect((await testWhatsAppConnectionAction()).ok).toBe(true);
    const row = await prisma.integration.findFirstOrThrow({ where: { provider: "WHATSAPP" } });
    expect(row).toMatchObject({ status: "CONNECTE", credentialsEncrypted: null });
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();

    meta.checkWhatsAppSender.mockResolvedValueOnce({ ok: false, error: "Meta a refusé la vérification du numéro d'envoi (HTTP 401)." });
    expect((await testWhatsAppConnectionAction()).ok).toBe(false);
    expect(await prisma.integration.findFirstOrThrow({ where: { provider: "WHATSAPP" } })).toMatchObject({ status: "ERREUR" });
    const alerts = await prismaBase.notification.findMany({ where: { type: "ERREUR_INTEGRATION" }, select: { userId: true } });
    expect(alerts.map((a) => a.userId)).toEqual([watcher.id]); // the actor is excluded, as for every connection test
    expect(admin.id).toBeTruthy();
  });

  it("requires integrations.manage", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(testWhatsAppConnectionAction()).rejects.toThrow(/Non autorisé/);
  });
});
