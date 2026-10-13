import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Staff WhatsApp alerts, 2026-10-12: per-user per-alert mutes, failed
 * syncs and failed store webhooks on WhatsApp — deduplicated per store per
 * day. The Meta provider is mocked: nothing is ever sent for real.
 */

const meta = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn<(to: string, message: unknown) => Promise<{ ok: boolean; messageId?: string; error?: string }>>(async () => ({ ok: true, messageId: "wamid.test" })),
}));
vi.mock("@/lib/whatsapp/client", () => ({
  isWhatsAppConfigured: () => true,
  sendTemplateMessage: meta.sendTemplateMessage,
  sendTemplate: vi.fn(),
  checkWhatsAppSender: vi.fn(),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendNotificationEmails: vi.fn(async () => {}),
}));

import { prisma, prismaBase } from "@/lib/prisma";
import { checkAndNotifyLowStock, notifySyncFailure } from "@/lib/notifications";
import { recordWebhookEventOnce } from "@/lib/integrations/shared/webhook-event";
import { setMyWhatsAppAlertMutedAction } from "@/actions/whatsapp";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

const sent = () =>
  meta.sendTemplateMessage.mock.calls.map((c) => {
    const [to, m] = c as [string, { templateName: string; parameters: string[] }];
    return { to, templateName: m.templateName, parameters: m.parameters };
  });

let seq = 0;
async function withWhatsApp(userId: string) {
  seq += 1;
  const phone = `2126${String(20_000_000 + seq).slice(-8)}`;
  await prismaBase.user.update({ where: { id: userId }, data: { whatsappPhone: phone, whatsappVerifiedAt: new Date(), whatsappOptInAt: new Date() } });
  return phone;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  meta.sendTemplateMessage.mockReset();
  meta.sendTemplateMessage.mockImplementation(async () => ({ ok: true as const, messageId: "wamid.test" }));
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("per-alert WhatsApp mute", () => {
  it("a muted type is not sent to that user; others still receive it; the in-app alert is unchanged", async () => {
    await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
    const wh = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "Sac", sku: "MUTE-1", price: 100, status: "ACTIF", trackInventory: true } });
    await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: product.id, quantityOnHand: 0 } });
    const muted = await createTestUser({ role: "OWNER" });
    const other = await createTestUser({ role: "ADMIN" });
    const mutedPhone = await withWhatsApp(muted.id);
    const otherPhone = await withWhatsApp(other.id);
    await prismaBase.user.update({ where: { id: muted.id }, data: { whatsappMutedAlerts: ["RUPTURE_STOCK"] } });

    await checkAndNotifyLowStock({ productIds: [product.id] });

    expect(sent().map((s) => s.to)).toEqual([otherPhone]);
    expect(sent().map((s) => s.to)).not.toContain(mutedPhone);
    expect(await prisma.notification.count({ where: { userId: muted.id, type: "RUPTURE_STOCK" } })).toBe(1);
  });

  it("the self-service action changes only the caller's own row and refuses unknown types", async () => {
    const me = await loginAsTestUser({ role: "WAREHOUSE" });
    const colleague = await createTestUser({ role: "WAREHOUSE" });

    const res = await setMyWhatsAppAlertMutedAction("ECHEC_LIVRAISON", true);
    expect(res).toEqual({ ok: true, data: { muted: ["ECHEC_LIVRAISON"] } });
    expect((await prismaBase.user.findUniqueOrThrow({ where: { id: me.id } })).whatsappMutedAlerts).toEqual(["ECHEC_LIVRAISON"]);
    expect((await prismaBase.user.findUniqueOrThrow({ where: { id: colleague.id } })).whatsappMutedAlerts).toEqual([]);

    expect((await setMyWhatsAppAlertMutedAction("ECHEC_LIVRAISON", false)).ok).toBe(true);
    expect((await prismaBase.user.findUniqueOrThrow({ where: { id: me.id } })).whatsappMutedAlerts).toEqual([]);
    expect(await setMyWhatsAppAlertMutedAction("COMMANDE_RETOURNEE", true)).toEqual({ ok: false, error: "Type d'alerte inconnu." });
  });
});

describe("sync failures on WhatsApp", () => {
  const run = (id: string, status: "ECHEC" | "PARTIEL") => ({
    id,
    provider: "WooCommerce" as const,
    resource: "COMMANDES",
    status,
    imported: 0,
    failed: 1,
    firstNote: "Boutique injoignable.",
  });

  it("a failed sync alerts once per store + resource per day (ten clicks on a broken store = one alert)", async () => {
    await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
    const admin = await createTestUser({ role: "ADMIN" });
    const phone = await withWhatsApp(admin.id);

    await notifySyncFailure(run("run-1", "ECHEC"));
    await notifySyncFailure(run("run-2", "ECHEC"));

    expect(sent()).toEqual([{ to: phone, templateName: "asoditech_integration_down", parameters: ["WooCommerce (synchronisation commandes)"] }]);
    expect(await prisma.notification.count({ where: { userId: admin.id, type: "ECHEC_SYNCHRONISATION" } })).toBe(1);
  });

  it("a partial sync stays in-app only, one per run", async () => {
    await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
    const admin = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(admin.id);
    await notifySyncFailure(run("run-3", "PARTIEL"));
    await notifySyncFailure(run("run-4", "PARTIEL"));
    expect(sent()).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: admin.id, type: "ECHEC_SYNCHRONISATION" } })).toBe(2);
  });

  it("a webhook delivery recorded ECHEC alerts once per integration per day; TRAITE / IGNORE never", async () => {
    await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
    const woo = await prisma.integration.create({ data: { provider: "WOOCOMMERCE", status: "CONNECTE" } });
    const admin = await createTestUser({ role: "ADMIN" });
    const phone = await withWhatsApp(admin.id);

    const base = { integrationId: woo.id, provider: "WOOCOMMERCE" as const, topic: "order.created" };
    await recordWebhookEventOnce({ ...base, deliveryId: "ok-1", status: "TRAITE" });
    await recordWebhookEventOnce({ ...base, deliveryId: "ign-1", status: "IGNORE" });
    expect(await prisma.notification.count()).toBe(0);

    await recordWebhookEventOnce({ ...base, deliveryId: "ko-1", status: "ECHEC" });
    await recordWebhookEventOnce({ ...base, deliveryId: "ko-2", status: "ECHEC" });
    await recordWebhookEventOnce({ ...base, deliveryId: "ko-1", status: "ECHEC" }); // the store's retry, failing again

    const rows = await prisma.notification.findMany({ where: { userId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "ECHEC_SYNCHRONISATION", entityType: "Integration", entityId: woo.id });
    expect(sent()).toEqual([{ to: phone, templateName: "asoditech_integration_down", parameters: ["WooCommerce (webhooks)"] }]);
  });

  it("muting ECHEC_SYNCHRONISATION stops these WhatsApp messages only", async () => {
    await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
    const admin = await createTestUser({ role: "ADMIN" });
    await withWhatsApp(admin.id);
    await prismaBase.user.update({ where: { id: admin.id }, data: { whatsappMutedAlerts: ["ECHEC_SYNCHRONISATION"] } });
    await notifySyncFailure(run("run-5", "ECHEC"));
    expect(sent()).toEqual([]);
    expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(1);
  });
});
