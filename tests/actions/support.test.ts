import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { reportProblemAction } from "@/actions/support";
import { updateBusinessSettingsAction } from "@/actions/settings";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

// Capture the forwarded support email without hitting Resend.
const { sendSupportTicketEmail } = vi.hoisted(() => ({ sendSupportTicketEmail: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendSupportTicketEmail }));

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("reportProblemAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    sendSupportTicketEmail.mockClear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("forwards to the configured support email, with the reporter's role", async () => {
    const owner = await loginAsTestUser({ role: "OWNER" });
    await updateBusinessSettingsAction(fd({ companyName: "X", supportEmail: "help@boutique.ma" }));
    mockCookieStore.clear();
    await loginAsTestUser({ role: "CONFIRMATION" });

    await reportProblemAction(fd({ category: "commande", description: "Une description assez longue pour passer." }));

    expect(sendSupportTicketEmail).toHaveBeenCalledTimes(1);
    expect(sendSupportTicketEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "help@boutique.ma", reporterRole: expect.any(String) }),
    );
    void owner;
  });

  it("falls back to asoditech@gmail.com when no support email is configured", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await reportProblemAction(fd({ category: "autre", description: "Une description assez longue pour passer." }));

    expect(sendSupportTicketEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "asoditech@gmail.com" }),
    );
  });

  it("lets any authenticated user report — no special permission needed", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    const result = await reportProblemAction(
      fd({ category: "bug", description: "Le bouton Enregistrer ne répond pas sur la page produit." }),
    );
    expect(result.ok).toBe(true);
    const ticket = await prisma.supportTicket.findFirstOrThrow();
    expect(ticket.category).toBe("bug");
    expect(ticket.status).toBe("OPEN");
  });

  it("rejects a description that is too short", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const result = await reportProblemAction(fd({ category: "autre", description: "bug" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.description).toBeTruthy();
    expect(await prisma.supportTicket.count()).toBe(0);
  });

  it("rejects an unknown category rather than storing it", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const result = await reportProblemAction(
      fd({ category: "definitely-not-a-category", description: "A description long enough to pass." }),
    );
    expect(result.ok).toBe(false);
  });

  it("captures the page and the order context when provided", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await reportProblemAction(
      fd({
        category: "commande",
        description: "Le total affiché ne correspond pas au montant encaissé.",
        pageUrl: "/commandes/clx0order1234567890abcd",
        contextType: "Order",
        contextId: "clx0order1234567890abcd",
      }),
    );
    const ticket = await prisma.supportTicket.findFirstOrThrow();
    expect(ticket.pageUrl).toBe("/commandes/clx0order1234567890abcd");
    expect(ticket.contextType).toBe("Order");
    expect(ticket.contextId).toBe("clx0order1234567890abcd");
  });

  it("notifies owners/admins (settings.view) but never the reporter, and not a manager", async () => {
    const owner = await createTestUser({ role: "OWNER" });
    await createTestUser({ role: "MANAGER" });
    const reporter = await loginAsTestUser({ role: "ADMIN" });

    await reportProblemAction(fd({ category: "autre", description: "Une description suffisamment longue." }));

    const notifications = await prisma.notification.findMany({ where: { type: "SUPPORT_TICKET" } });
    expect(notifications.map((n) => n.userId).sort()).toEqual([owner.id].sort());
    expect(notifications.map((n) => n.userId)).not.toContain(reporter.id);
  });

  it("records a support.ticket_created audit event", async () => {
    const user = await loginAsTestUser({ role: "SUPPORT" });
    await reportProblemAction(fd({ category: "compte", description: "Je n'arrive pas à accéder à une page." }));
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: "support.ticket_created" } });
    expect(event.actorUserId).toBe(user.id);
    expect(event.entityType).toBe("SupportTicket");
  });
});

describe("support settings persistence", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("stores WhatsApp and phone as independent fields", async () => {
    const user = await loginAsTestUser({ role: "OWNER" });
    const result = await updateBusinessSettingsAction(
      fd({
        companyName: "100 D ryal",
        supportName: "YounessWeb Support",
        supportWhatsapp: "+212600112233",
        supportPhone: "+212522445566",
        supportEmail: "support@example.com",
        supportHours: "Lun–Sam, 9h–18h",
      }),
    );
    expect(result.ok).toBe(true);

    const settings = await prisma.businessSettings.findFirstOrThrow({ where: { tenantId: user.tenantId } });
    expect(settings.supportWhatsapp).toBe("+212600112233");
    expect(settings.supportPhone).toBe("+212522445566");
    expect(settings.supportWhatsapp).not.toBe(settings.supportPhone);
    expect(settings.supportName).toBe("YounessWeb Support");
    expect(settings.supportHours).toBe("Lun–Sam, 9h–18h");
  });

  it("rejects a malformed support number", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const result = await updateBusinessSettingsAction(
      fd({ companyName: "X", supportWhatsapp: "not a phone!!" }),
    );
    expect(result.ok).toBe(false);
  });

  it("a non-manager settings user cannot change support config", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    await expect(
      updateBusinessSettingsAction(fd({ companyName: "X", supportPhone: "+212600000000" })),
    ).rejects.toThrow(/non autorisé/i);
  });
});
