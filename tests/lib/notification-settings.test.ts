import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paramètres → Notifications (docs/adr/0058 "Final responsibility split").
 * The page is a read-only mirror of the engine: these tests pin that what
 * it SHOWS is what the engine DOES, and that it only reaches the session
 * user. Meta/email transports are mocked (no network).
 */

const meta = vi.hoisted(() => ({ configured: true, sendTemplateMessage: vi.fn(async () => ({ ok: true as const, messageId: null })) }));
vi.mock("@/lib/whatsapp/client", () => ({
  isWhatsAppConfigured: () => meta.configured,
  sendTemplateMessage: meta.sendTemplateMessage,
  sendTemplate: vi.fn(),
  checkWhatsAppSender: vi.fn(),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendNotificationEmails: vi.fn(async () => {}),
}));

import { prisma, prismaBase } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { loadEffectiveAccessMany } from "@/lib/auth/access-loader";
import { ALERT_RULES, alertsForUser, getMyNotificationSettings, whatsAppStatus } from "@/lib/notification-settings";
import { checkAndNotifyLowStock, notifyConnectionError, notifyNewOrder, notifyShipmentFailed, notifySupportTicket } from "@/lib/notifications";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { saveMyWhatsAppNumberAction, setMyWhatsAppOptInAction } from "@/actions/whatsapp";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser, grantLocationAccess, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

beforeEach(async () => {
  await resetDb();
  meta.configured = true;
});
afterEach(async () => {
  await resetDb();
});

describe("WhatsApp status shown = the conditions the dispatcher checks", () => {
  it("covers every state", () => {
    const base = { channelAvailable: true, phone: "212612345678", verified: true, optedIn: true };
    expect(whatsAppStatus(base)).toBe("active");
    expect(whatsAppStatus({ ...base, optedIn: false })).toBe("disabled");
    expect(whatsAppStatus({ ...base, verified: false, optedIn: false })).toBe("pending");
    expect(whatsAppStatus({ ...base, phone: null })).toBe("no_number");
    expect(whatsAppStatus({ ...base, channelAvailable: false })).toBe("unavailable");
  });

  it("the loader reflects the tenant switch, the central config, the user's number, verification and opt-in — and never the raw number", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    const me = (await getCurrentUser())!;

    meta.configured = false;
    expect((await getMyNotificationSettings(me)).whatsapp).toMatchObject({ status: "unavailable", unavailableReason: "not_configured" });
    meta.configured = true;
    expect((await getMyNotificationSettings(me)).whatsapp).toMatchObject({ status: "unavailable", unavailableReason: "tenant_disabled" });

    await prisma.integration.create({ data: { provider: "WHATSAPP", status: "CONNECTE" } });
    expect((await getMyNotificationSettings(me)).whatsapp.status).toBe("no_number");

    await saveMyWhatsAppNumberAction((() => { const f = new FormData(); f.set("phone", "0612345678"); return f; })());
    const pending = await getMyNotificationSettings(me);
    expect(pending.whatsapp.status).toBe("pending");
    expect(JSON.stringify(pending)).not.toContain("212612345678");

    await prismaBase.user.update({ where: { id: me.id }, data: { whatsappVerifiedAt: new Date() } });
    expect((await getMyNotificationSettings(me)).whatsapp.status).toBe("disabled");
    expect((await setMyWhatsAppOptInAction(true)).ok).toBe(true);
    expect((await getMyNotificationSettings(me)).whatsapp.status).toBe("active");

    // Tenant switch off again → shown unavailable even though the user stays opted in.
    await prisma.integration.updateMany({ where: { provider: "WHATSAPP" }, data: { status: "DECONNECTE" } });
    expect((await getMyNotificationSettings(me)).whatsapp).toMatchObject({ status: "unavailable", optedIn: true });
  });

  it("email shows the user's own address; the channel is reported unavailable when not configured (always, under tests)", async () => {
    await loginAsTestUser({ role: "CONFIRMATION", email: "agent@example.test" });
    const s = await getMyNotificationSettings((await getCurrentUser())!);
    expect(s.email).toEqual({ address: "agent@example.test", available: false });
  });
});

describe("communication settings are personal and server-enforced", () => {
  it("every role can load its own settings (no settings.view needed)", async () => {
    await loginAsTestUser({ role: "STORE_SELLER" });
    const me = (await getCurrentUser())!;
    expect(me.permissions.has("settings.view")).toBe(false);
    await expect(getMyNotificationSettings(me)).resolves.toBeTruthy();
  });

  it("without a session the actions refuse — no anonymous change", async () => {
    mockCookieStore.clear();
    await expect(saveMyWhatsAppNumberAction(new FormData())).rejects.toThrow(/Non autorisé/);
    await expect(setMyWhatsAppOptInAction(true)).rejects.toThrow(/Non autorisé/);
  });
});

describe("the alert list shown to a user = the alerts the engine actually delivers to them", () => {
  it("per role and per-user override, an alert is listed iff that user receives its in-app notification", async () => {
    const wh = await prisma.warehouse.create({ data: { name: "Magasin", type: "MAGASIN" } });
    const product = await prisma.product.create({ data: { name: "P", sku: "NS-1", price: 1, status: "ACTIF", trackInventory: true, lowStockThreshold: 5 } });
    await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: product.id, quantityOnHand: 0 } });
    const roles = ["OWNER", "ADMIN", "MANAGER", "CONFIRMATION", "WAREHOUSE", "DELIVERY", "SUPPORT", "ACCOUNTANT", "STORE_SELLER"] as const;
    const users = [];
    for (const role of roles) {
      const u = await createTestUser({ role });
      await grantLocationAccess(u.id, wh.id);
      users.push(u);
    }
    // Per-user overrides (docs/adr/0039) — the list must follow EFFECTIVE permissions, not the role.
    const granted = await createTestUser({ role: "CONFIRMATION" });
    await grantLocationAccess(granted.id, wh.id);
    await prisma.userPermissionOverride.createMany({
      data: ["settings.view", "inventory.view", "delivery.view"].map((permission) => ({ userId: granted.id, permission, effect: "GRANT" as const })),
    });
    const denied = await createTestUser({ role: "MANAGER" });
    await grantLocationAccess(denied.id, wh.id);
    await prisma.userPermissionOverride.createMany({
      data: ["inventory.view", "orders.view"].map((permission) => ({ userId: denied.id, permission, effect: "DENY" as const })),
    });
    users.push(granted, denied);

    await checkAndNotifyLowStock({ productIds: [product.id] }); // rupture
    await notifyShipmentFailed({ id: "s1", orderId: "o1", orderNumber: 1, providerName: "Amana" }); // echec_livraison
    await notifyConnectionError({ entityType: "Integration", entityId: "i1", label: "WooCommerce", recipientPermission: "integrations.view" });
    await checkAndNotifyUsageThreshold(DEFAULT_TENANT_ID, "ORDERS", { used: 100, limit: 100, percent: 100, status: "LIMIT_REACHED" }); // limite_forfait
    await notifyNewOrder({ id: "o1", orderNumber: 1, total: 1, currency: "MAD", customerName: "C", source: "INTERNE" }); // commandes
    await notifySupportTicket({ id: "t1", categoryLabel: "Bug", reporterName: "X" }); // support

    const typeOf: Record<string, string> = {
      rupture: "RUPTURE_STOCK",
      echec_livraison: "ECHEC_LIVRAISON",
      limite_forfait: "USAGE_LIMIT_ALERT",
      commandes: "NOUVELLE_COMMANDE",
      support: "SUPPORT_TICKET",
    };
    const access = await loadEffectiveAccessMany(users);
    for (const u of users) {
      const listed = new Set(alertsForUser(access.get(u.id)!.permissions).map((r) => r.key));
      const got = new Set((await prismaBase.notification.findMany({ where: { userId: u.id }, select: { type: true } })).map((n) => n.type));
      for (const [key, type] of Object.entries(typeOf)) {
        expect({ role: u.role, key, listed: listed.has(key) }).toEqual({ role: u.role, key, listed: got.has(type as never) });
      }
      // Store-integration errors go to integrations.view holders; the row is also listed for
      // delivery.view-only users (carrier errors), so "received ⇒ listed" is the safe direction.
      if (got.has("ERREUR_INTEGRATION")) expect(listed.has("erreur_integration")).toBe(true);
    }
  });

  it("only the three supported critical alerts offer WhatsApp; email also covers the plan limit", () => {
    const whatsapp = ALERT_RULES.filter((r) => r.channels.includes("whatsapp")).map((r) => r.key).sort();
    expect(whatsapp).toEqual(["echec_livraison", "erreur_integration", "rupture"]);
    const email = ALERT_RULES.filter((r) => r.channels.includes("email")).map((r) => r.key).sort();
    expect(email).toEqual(["echec_livraison", "erreur_integration", "limite_forfait", "rupture"]);
  });
});
