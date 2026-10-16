import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff WhatsApp outbox — DB-backed (docs/adr/0058 addendum, 2026-10-16).
 * WRITTEN, NOT YET RUN (needs the test database + the
 * 20261016120000_delivery_payment_brand_logo_whatsapp_outbox migration).
 * The Meta client is mocked: nothing is ever sent for real. The template
 * availability list (WHATSAPP_ENABLED_TEMPLATES) is mocked too.
 */

const meta = vi.hoisted(() => ({
  configured: true,
  sendTemplateMessage: vi.fn<(to: string, message: unknown) => Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }>>(
    async () => ({ ok: true, messageId: "wamid.test" })
  ),
}));
vi.mock("@/lib/whatsapp/client", () => ({
  isWhatsAppConfigured: () => meta.configured,
  sendTemplateMessage: meta.sendTemplateMessage,
  sendTemplate: vi.fn(),
  checkWhatsAppSender: vi.fn(),
}));
const templates = vi.hoisted(() => ({ enabled: new Set<string>() }));
vi.mock("@/lib/whatsapp/template-config", () => ({ getEnabledWhatsAppTemplates: () => templates.enabled }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendNotificationEmails: vi.fn(async () => {}),
}));

import { prisma, prismaBase } from "@/lib/prisma";
import { notifyConnectionError, notifyNewOrder, notifyOrderReturned, checkAndNotifyLowStock } from "@/lib/notifications";
import { processDueWhatsAppOutbox, processWhatsAppOutboxForAllTenants, retryWhatsAppOutboxMessage } from "@/lib/whatsapp/outbox";
import { retryWhatsAppOutboxMessageAction, setCompanyWhatsAppAlertEnabledAction } from "@/actions/whatsapp";
import { runWithTenant } from "@/lib/tenant/context";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

let seq = 0;
async function withWhatsApp(userId: string) {
  seq += 1;
  const phone = `2126${String(30_000_000 + seq).slice(-8)}`;
  await prismaBase.user.update({ where: { id: userId }, data: { whatsappPhone: phone, whatsappVerifiedAt: new Date(), whatsappOptInAt: new Date() } });
  return phone;
}
const sentTo = () => meta.sendTemplateMessage.mock.calls.map((c) => c[0]);
const connectionError = (entityId = "int-1") =>
  notifyConnectionError({ entityType: "Integration", entityId, label: "WooCommerce", recipientPermission: "integrations.view" });
const order = (id: string) => ({ id, orderNumber: 1001, total: 10, currency: "MAD", customerName: "Client", source: "WOOCOMMERCE" as const });

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  meta.configured = true;
  templates.enabled = new Set();
  meta.sendTemplateMessage.mockReset();
  meta.sendTemplateMessage.mockImplementation(async () => ({ ok: true as const, messageId: "wamid.test" }));
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

async function enabledTenant() {
  await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
}

describe("enqueue → send", () => {
  it("one outbox row per (event, recipient), ENVOYE with the provider id; the number is never stored", async () => {
    await enabledTenant();
    const admin = await createTestUser({ role: "ADMIN" });
    const phone = await withWhatsApp(admin.id);
    await connectionError();
    const rows = await prisma.whatsAppOutboxMessage.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: admin.id, status: "ENVOYE", providerMessageId: "wamid.test", attempts: 1, templateName: "asoditech_integration_down" });
    expect(rows[0].sentAt).not.toBeNull();
    expect(JSON.stringify(rows[0])).not.toContain(phone);
  });

  it("idempotent: the same dedupeKey twice → one row, one send", async () => {
    await enabledTenant();
    const admin = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(admin.id);
    await connectionError();
    await prisma.notification.deleteMany(); // even after the bell row was dismissed
    await connectionError();
    await Promise.all([connectionError(), connectionError()]);
    expect(await prisma.whatsAppOutboxMessage.count()).toBe(1);
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("nothing is recorded when the tenant switch is off or the sender is not configured", async () => {
    const admin = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(admin.id);
    await connectionError("a");
    meta.configured = false;
    await enabledTenant();
    await connectionError("b");
    expect(await prismaBase.whatsAppOutboxMessage.count()).toBe(0);
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

describe("opt-out / mute / company-disabled", () => {
  it("a muted user, a not-opted-in user and a company-disabled category get no row and no send; others do", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    const muted = await createTestUser({ role: "ADMIN" });
    const notOptedIn = await createTestUser({ role: "ADMIN" });
    const phoneA = await withWhatsApp(a.id);
    await withWhatsApp(muted.id);
    await withWhatsApp(notOptedIn.id);
    await prismaBase.user.update({ where: { id: muted.id }, data: { whatsappMutedAlerts: ["ERREUR_INTEGRATION"] } });
    await prismaBase.user.update({ where: { id: notOptedIn.id }, data: { whatsappOptInAt: null } });
    await connectionError("x");
    expect(sentTo()).toEqual([phoneA]);

    await prisma.businessSettings.upsert({ where: { tenantId: DEFAULT_TENANT_ID }, update: { whatsappDisabledAlerts: ["ERREUR_INTEGRATION"] }, create: { whatsappDisabledAlerts: ["ERREUR_INTEGRATION"] } });
    await connectionError("y");
    expect(sentTo()).toEqual([phoneA]);
    expect(await prisma.notification.count({ where: { entityId: "y" } })).toBe(3); // in-app unchanged
  });

  it("a row already queued becomes IGNORE when the category is switched off before its retry", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: false, error: "HTTP 503" }));
    await connectionError();
    const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(row.status).toBe("EN_ATTENTE");
    await prisma.businessSettings.upsert({ where: { tenantId: DEFAULT_TENANT_ID }, update: { whatsappDisabledAlerts: ["ERREUR_INTEGRATION"] }, create: { whatsappDisabledAlerts: ["ERREUR_INTEGRATION"] } });
    await prisma.whatsAppOutboxMessage.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await processDueWhatsAppOutbox();
    expect(await prisma.whatsAppOutboxMessage.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "IGNORE", lastError: "Catégorie d'alerte désactivée par l'entreprise." });
  });
});

describe("template availability (configuration problem ≠ business failure)", () => {
  it("a new template not listed → IGNORE « non approuvé/configuré », never sent; listed → sent", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    await notifyNewOrder(order("o-1"));
    const ignored = await prisma.whatsAppOutboxMessage.findFirstOrThrow({ where: { alertType: "NOUVELLE_COMMANDE" } });
    expect(ignored).toMatchObject({ status: "IGNORE", templateName: "asoditech_new_order", attempts: 0 });
    expect(ignored.lastError).toMatch(/non approuvé\/configuré/);
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();

    templates.enabled = new Set(["asoditech_new_order", "asoditech_order_returned"]);
    await notifyNewOrder(order("o-2"));
    await notifyOrderReturned({ id: "o-2", orderNumber: 1001, customerName: "Client" });
    expect(meta.sendTemplateMessage.mock.calls.map((c) => (c[1] as { templateName: string }).templateName).sort()).toEqual([
      "asoditech_new_order",
      "asoditech_order_returned",
    ]);
  });

  it("low stock goes to WhatsApp once per item per day even if the in-app row is resolved and re-created", async () => {
    templates.enabled = new Set(["asoditech_stock_low"]);
    await enabledTenant();
    const owner = await createTestUser({ role: "OWNER" });
    await withWhatsApp(owner.id);
    const wh = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "Sac", sku: "LOW-1", price: 1, status: "ACTIF", trackInventory: true, lowStockThreshold: 5 } });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: product.id, quantityOnHand: 3 } });
    await checkAndNotifyLowStock({ productIds: [product.id] });
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: 10 } });
    await checkAndNotifyLowStock({ productIds: [product.id] }); // recovered → in-app resolved
    await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: 2 } });
    await checkAndNotifyLowStock({ productIds: [product.id] }); // low again, same day
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect((meta.sendTemplateMessage.mock.calls[0][1] as { parameters: string[] }).parameters).toEqual(["Sac", "3", "Entrepôt"]);
  });
});

describe("retries", () => {
  it("a transient failure is retried with backoff and then sent", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementationOnce(async () => ({ ok: false, error: "HTTP 503" }));
    await connectionError();
    let row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(row).toMatchObject({ status: "EN_ATTENTE", attempts: 1 });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(row.lastError).toMatch(/temporaire/);

    await processDueWhatsAppOutbox(); // not due yet
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);

    await prisma.whatsAppOutboxMessage.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await processDueWhatsAppOutbox();
    row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(row).toMatchObject({ status: "ENVOYE", attempts: 2, lastError: null });
  });

  it("exhaustion → ECHEC after the max attempts; a permanent refusal → ECHEC at once", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: false, error: "TimeoutError" }));
    await connectionError("t");
    for (let i = 0; i < 10; i++) {
      await prisma.whatsAppOutboxMessage.updateMany({ where: { status: "EN_ATTENTE" }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await processDueWhatsAppOutbox();
    }
    const exhausted = await prisma.whatsAppOutboxMessage.findFirstOrThrow({ where: { dedupeKey: { contains: ":t:" } } });
    expect(exhausted).toMatchObject({ status: "ECHEC", attempts: 5 });

    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: false, error: "HTTP 400 code=132001 type=OAuthException" }));
    await connectionError("p");
    const refused = await prisma.whatsAppOutboxMessage.findFirstOrThrow({ where: { dedupeKey: { contains: ":p:" } } });
    expect(refused).toMatchObject({ status: "ECHEC", attempts: 1 });
    expect(refused.lastError).toContain("code=132001");
  });

  it("two concurrent processors claim a due row once → exactly one send", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementationOnce(async () => ({ ok: false, error: "HTTP 503" }));
    await connectionError();
    await prisma.whatsAppOutboxMessage.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    meta.sendTemplateMessage.mockClear();
    await Promise.all([processDueWhatsAppOutbox(), processDueWhatsAppOutbox(), processDueWhatsAppOutbox()]);
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("a stale EN_COURS claim (processor died) is claimed again; a fresh one is not", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementationOnce(async () => ({ ok: false, error: "HTTP 503" }));
    await connectionError();
    const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    await prisma.whatsAppOutboxMessage.update({ where: { id: row.id }, data: { status: "EN_COURS" } });
    meta.sendTemplateMessage.mockClear();
    await processDueWhatsAppOutbox();
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled(); // fresh claim: someone is sending it
    // Through the client (an explicit value overrides @updatedAt): a raw
    // UPDATE runs outside the RLS bypass and silently matches no row.
    await prismaBase.whatsAppOutboxMessage.update({ where: { id: row.id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });
    await processDueWhatsAppOutbox();
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("stale / concurrent results never overwrite a newer state", () => {
  const backdateClaim = (id: string) =>
    prismaBase.whatsAppOutboxMessage.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 10 * 60_000) } });

  it("a slow holder whose claim was retaken cannot overwrite the new holder's ENVOYE", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    // Holder A = the send right after enqueue. While A is "stuck" at Meta its
    // claim goes stale, holder B retakes it and succeeds; then A's late
    // permanent refusal comes back.
    meta.sendTemplateMessage
      .mockImplementationOnce(async () => {
        const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
        await backdateClaim(row.id);
        await processDueWhatsAppOutbox();
        return { ok: false, error: "HTTP 400 code=132001 type=OAuthException" };
      })
      .mockImplementationOnce(async () => ({ ok: true, messageId: "wamid.B" }));
    await connectionError();
    const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({ status: "ENVOYE", providerMessageId: "wamid.B", attempts: 2, lastError: null });
  });

  it("ABA: after ECHEC + manual « Réessayer » (attempts reset), the old holder still cannot write over the new claim", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    let cInFlight!: () => void;
    const cStarted = new Promise<void>((r) => (cInFlight = r));
    let releaseC!: () => void;
    const cGate = new Promise<void>((r) => (releaseC = r));
    let retryP: Promise<unknown> | null = null;

    meta.sendTemplateMessage
      // A: claim attempts=1, goes stale.
      .mockImplementationOnce(async () => {
        const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
        await backdateClaim(row.id);
        await processDueWhatsAppOutbox(); // B: attempts=2 → permanent refusal → ECHEC
        expect((await prisma.whatsAppOutboxMessage.findFirstOrThrow()).status).toBe("ECHEC");
        retryP = retryWhatsAppOutboxMessage(row.id); // C: reset → claim attempts=1 again
        await cStarted;
        return { ok: false, error: "HTTP 400 code=132001 type=OAuthException" }; // A's late answer
      })
      .mockImplementationOnce(async () => ({ ok: false, error: "HTTP 400 code=132001 type=OAuthException" })) // B
      .mockImplementationOnce(async () => {
        cInFlight();
        await cGate;
        return { ok: true, messageId: "wamid.C" };
      });

    await connectionError(); // A finished (its write must have been refused)
    let row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(row).toMatchObject({ status: "EN_COURS", attempts: 1 }); // still C's claim, not A's ECHEC
    releaseC();
    expect(await retryP).toBe("ENVOYE");
    row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(row).toMatchObject({ status: "ENVOYE", providerMessageId: "wamid.C", lastError: null });
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(3);
  });

  it("a row already ENVOYE is never re-claimed, re-sent or re-written (even when targeted by id)", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementationOnce(async () => ({ ok: false, error: "HTTP 503" }));
    await connectionError();
    const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    // A row already ENVOYE by someone else is never claimed, re-sent or re-written.
    await prisma.whatsAppOutboxMessage.update({ where: { id: row.id }, data: { status: "ENVOYE", providerMessageId: "wamid.done", nextAttemptAt: new Date(Date.now() - 1000) } });
    meta.sendTemplateMessage.mockClear();
    expect(await processDueWhatsAppOutbox({ onlyIds: [row.id] })).toMatchObject({ sent: 0, failed: 0, ignored: 0, retrying: 0 });
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();
    expect(await prisma.whatsAppOutboxMessage.findFirstOrThrow()).toMatchObject({ status: "ENVOYE", providerMessageId: "wamid.done" });
  });
});

describe("expiry: automatic vs manual retry", () => {
  it("an automatic pass never sends a row older than 24 h (ECHEC « Délai »); a manual « Réessayer » may", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    meta.sendTemplateMessage.mockImplementationOnce(async () => ({ ok: false, error: "HTTP 503" }));
    await connectionError();
    const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    await prismaBase.whatsAppOutboxMessage.update({
      where: { id: row.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000), nextAttemptAt: new Date(Date.now() - 1000) },
    });
    meta.sendTemplateMessage.mockClear();
    expect(await processDueWhatsAppOutbox()).toMatchObject({ failed: 1, sent: 0 });
    expect(meta.sendTemplateMessage).not.toHaveBeenCalled();
    expect(await prisma.whatsAppOutboxMessage.findFirstOrThrow()).toMatchObject({ status: "ECHEC", lastError: expect.stringMatching(/Délai/) });

    expect(await retryWhatsAppOutboxMessage(row.id)).toBe("ENVOYE");
    expect(meta.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("tenant isolation", () => {
  it("rows are tenant-scoped; the cron pass processes each tenant only inside its own context", async () => {
    await enabledTenant();
    const a = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(a.id);
    await prismaBase.tenant.create({ data: { id: "tenant-b-outbox", name: "B", slug: "tenant-b-outbox" } });
    await prismaBase.integration.create({ data: { tenantId: "tenant-b-outbox", provider: "WHATSAPP", status: "CONNECTE" } });
    const b = await createTestUser({ role: "ADMIN", tenantId: "tenant-b-outbox" });
    const phoneB = await withWhatsApp(b.id);

    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: false, error: "HTTP 503" }));
    await runWithTenant(DEFAULT_TENANT_ID, "test", () => connectionError("ia"));
    await runWithTenant("tenant-b-outbox", "test", () => connectionError("ib"));
    expect(await runWithTenant(DEFAULT_TENANT_ID, "test", () => prisma.whatsAppOutboxMessage.count())).toBe(1);
    expect(await prismaBase.whatsAppOutboxMessage.count()).toBe(2);

    await prismaBase.whatsAppOutboxMessage.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    meta.sendTemplateMessage.mockReset();
    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: true as const, messageId: "wamid.x" }));
    // Tenant A's pass never touches B's row.
    await processDueWhatsAppOutbox({ tenantId: DEFAULT_TENANT_ID });
    expect(sentTo()).not.toContain(phoneB);
    expect((await prismaBase.whatsAppOutboxMessage.findFirstOrThrow({ where: { tenantId: "tenant-b-outbox" } })).status).toBe("EN_ATTENTE");

    const summary = await processWhatsAppOutboxForAllTenants();
    expect(summary).toMatchObject({ tenants: 1, sent: 1 });
    expect(sentTo()).toContain(phoneB);
  });

  it("a suspended tenant's rows are not processed by the cron", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-s-outbox", name: "S", slug: "tenant-s-outbox", status: "SUSPENDED" } });
    const s = await createTestUser({ role: "ADMIN", tenantId: "tenant-s-outbox" });
    await prismaBase.whatsAppOutboxMessage.create({
      data: { tenantId: "tenant-s-outbox", userId: s.id, dedupeKey: "k", templateName: "asoditech_stock_out", payload: { language: "fr", parameters: ["a", "b"] } },
    });
    expect(await processWhatsAppOutboxForAllTenants()).toMatchObject({ tenants: 0 });
  });
});

describe("admin actions", () => {
  it("« Réessayer »: integrations.manage only, ECHEC rows of the own tenant only, audited", async () => {
    await enabledTenant();
    const target = await createTestUser({ role: "OWNER" });
    await withWhatsApp(target.id);
    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: false, error: "HTTP 400" }));
    await connectionError();
    const row = await prisma.whatsAppOutboxMessage.findFirstOrThrow();
    expect(row.status).toBe("ECHEC");

    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(retryWhatsAppOutboxMessageAction(row.id)).rejects.toThrow(/permission/);

    const admin = await loginAsTestUser({ role: "ADMIN" });
    meta.sendTemplateMessage.mockImplementation(async () => ({ ok: true as const, messageId: "wamid.retry" }));
    expect(await retryWhatsAppOutboxMessageAction(row.id)).toEqual({ ok: true, data: { status: "ENVOYE" } });
    expect(await retryWhatsAppOutboxMessageAction(row.id)).toMatchObject({ ok: false }); // no longer ECHEC
    expect(await prisma.auditEvent.count({ where: { action: "whatsapp.outbox_retried", actorUserId: admin.id } })).toBe(1);

    // Another tenant's ECHEC row is not found.
    await prismaBase.tenant.create({ data: { id: "tenant-r-outbox", name: "R", slug: "tenant-r-outbox" } });
    const foreignUser = await createTestUser({ role: "ADMIN", tenantId: "tenant-r-outbox" });
    const foreign = await prismaBase.whatsAppOutboxMessage.create({
      data: { tenantId: "tenant-r-outbox", userId: foreignUser.id, dedupeKey: "f", templateName: "asoditech_stock_out", payload: { language: "fr", parameters: ["a", "b"] }, status: "ECHEC" },
    });
    expect(await retryWhatsAppOutboxMessageAction(foreign.id)).toEqual({ ok: false, error: "Envoi introuvable." });
    expect((await prismaBase.whatsAppOutboxMessage.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe("ECHEC");
  });

  it("company category switch: integrations.manage only, known types only, audited", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(setCompanyWhatsAppAlertEnabledAction("NOUVELLE_COMMANDE", false)).rejects.toThrow(/permission/);
    const admin = await loginAsTestUser({ role: "ADMIN" });
    expect(await setCompanyWhatsAppAlertEnabledAction("NOUVELLE_COMMANDE", false)).toEqual({ ok: true, data: { disabled: ["NOUVELLE_COMMANDE"] } });
    expect(await setCompanyWhatsAppAlertEnabledAction("PROBLEME_PAIEMENT", false)).toEqual({ ok: false, error: "Type d'alerte inconnu." });
    expect(await setCompanyWhatsAppAlertEnabledAction("NOUVELLE_COMMANDE", true)).toEqual({ ok: true, data: { disabled: [] } });
    expect(await prisma.auditEvent.count({ where: { action: "whatsapp.alert_category_updated", actorUserId: admin.id } })).toBe(2);
  });
});
