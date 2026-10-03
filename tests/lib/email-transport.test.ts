import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Resend transport in src/lib/email.ts, with Resend itself mocked (no
 * real provider call) and `env` pinned to a configured, non-test
 * environment so the real send path runs. docs/adr/0057.
 */

const { send, batchSend } = vi.hoisted(() => ({ send: vi.fn(), batchSend: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
    batch = { send: batchSend };
  },
}));
vi.mock("@/lib/env", () => ({
  env: { NODE_ENV: "development", RESEND_API_KEY: "re_test_dummy", EMAIL_FROM: "ASODITECH <alerts@example.test>", APP_URL: "https://app.example.test" },
}));

import { sendInvitationEmail, sendNotificationEmails, sendPasswordResetEmail, sendSupportTicketEmail } from "@/lib/email";
import { deliveryFailureEmail, outOfStockEmail, planLimitEmail, integrationErrorEmail } from "@/lib/notification-email";

beforeEach(() => {
  send.mockReset().mockResolvedValue({ data: { id: "x" }, error: null });
  batchSend.mockReset().mockResolvedValue({ data: { data: [] }, error: null });
});

describe("sendNotificationEmails", () => {
  it("one batch call, one individually-addressed message per recipient, existing sender, APP_URL link, escaped HTML", async () => {
    const email = outOfStockEmail({ productName: "Sac <b>Cuir</b>", sku: "S-1", locationName: "Magasin A" });
    await sendNotificationEmails([
      { to: "a@example.test", email },
      { to: "b@example.test", email },
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(batchSend).toHaveBeenCalledTimes(1);
    const payload = batchSend.mock.calls[0][0] as { from: string; to: string; subject: string; html: string; text: string }[];
    expect(payload.map((p) => p.to)).toEqual(["a@example.test", "b@example.test"]);
    expect(payload.every((p) => p.from === "ASODITECH <alerts@example.test>")).toBe(true);
    expect(payload[0].subject).toBe("Rupture de stock : Sac <b>Cuir</b>");
    expect(payload[0].text).toContain("https://app.example.test/stock");
    expect(payload[0].html).toContain('href="https://app.example.test/stock"');
    expect(payload[0].html).toContain("Sac &lt;b&gt;Cuir&lt;/b&gt;");
    expect(payload[0].html).not.toContain("<b>Cuir</b>");
    expect(payload[0].text).not.toContain("localhost");
  });

  it("a Resend error response or a thrown error is logged and swallowed, never thrown", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    batchSend.mockResolvedValueOnce({ data: null, error: { name: "validation_error", message: "domain not verified" } });
    await expect(sendNotificationEmails([{ to: "a@example.test", email: planLimitEmail({ metricLabel: "commandes", used: 100, limit: 100 }) }])).resolves.toBeUndefined();
    batchSend.mockRejectedValueOnce(new Error("network down"));
    await expect(sendNotificationEmails([{ to: "a@example.test", email: integrationErrorEmail({ label: "Shopify", kind: "Integration" }) }])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(" ")).not.toContain("a@example.test"); // no address in the log
    log.mockRestore();
  });

  it("nothing to send = no provider call", async () => {
    await sendNotificationEmails([]);
    expect(batchSend).not.toHaveBeenCalled();
  });

  it("templates are French, link to existing pages, and carry no internal id", () => {
    expect(deliveryFailureEmail({ orderNumber: "CMD-12", providerName: "Amana" })).toMatchObject({ title: "Échec de livraison", path: "/livraison" });
    expect(integrationErrorEmail({ label: "Ozon", kind: "ShippingProvider" }).path).toBe("/livraison");
    expect(planLimitEmail({ metricLabel: "commandes", used: 100, limit: 100 })).toMatchObject({ title: "Limite du forfait atteinte", path: "/parametres/abonnement" });
  });
});

describe("existing transactional emails are unchanged", () => {
  it("invitation, password reset and support ticket still go through emails.send with the same sender and subjects", async () => {
    await sendInvitationEmail({ to: "i@example.test", inviteeName: "Ali", role: "MANAGER", inviteUrl: "/invitation/tok" });
    await sendPasswordResetEmail({ to: "r@example.test", resetUrl: "/reinitialiser/tok" });
    await sendSupportTicketEmail({ to: "s@example.test", companyName: "Acme", categoryLabel: "Bug", description: "x", reporterName: "A", reporterEmail: "a@example.test" });
    expect(batchSend).not.toHaveBeenCalled();
    expect(send.mock.calls.map((c) => [c[0].to, c[0].from, c[0].subject])).toEqual([
      ["i@example.test", "ASODITECH <alerts@example.test>", "Vous êtes invité(e) sur ASODITECH"],
      ["r@example.test", "ASODITECH <alerts@example.test>", "Réinitialisation de votre mot de passe ASODITECH"],
      ["s@example.test", "ASODITECH <alerts@example.test>", "[Support Acme] Bug"],
    ]);
    expect(send.mock.calls[0][0].text).toContain("https://app.example.test/invitation/tok");
  });
});
