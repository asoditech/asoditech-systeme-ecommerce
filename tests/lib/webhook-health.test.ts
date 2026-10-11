import { describe, expect, it } from "vitest";
import { WEBHOOK_FAILURE_WINDOW_DAYS, webhookFailureMessage, webhookFailureSince } from "@/lib/integrations/shared/webhook-health";

const fmt = (d: Date) => d.toISOString().slice(0, 10);

describe("webhookFailureMessage — failed deliveries shown on the integration card", () => {
  it("nothing failed: no line", () => {
    expect(webhookFailureMessage(0, null, fmt)).toBeNull();
    expect(webhookFailureMessage(0, { receivedAt: new Date("2026-10-10"), topic: "order.created" }, fmt)).toBeNull();
  });

  it("one or several failures: count, window, last date and topic", () => {
    const last = { receivedAt: new Date("2026-10-10T08:00:00Z"), topic: "order.updated" };
    expect(webhookFailureMessage(1, last, fmt)).toBe(
      `1 webhook n'a pas pu être traité sur les ${WEBHOOK_FAILURE_WINDOW_DAYS} derniers jours (dernier : 2026-10-10, order.updated). Vérifiez les commandes concernées ou relancez la synchronisation des commandes.`
    );
    expect(webhookFailureMessage(3, last, fmt)).toMatch(/^3 webhooks n'ont pas pu être traités/);
  });

  it("the window starts 7 days before now", () => {
    expect(webhookFailureSince(new Date("2026-10-11T12:00:00Z")).toISOString()).toBe("2026-10-04T12:00:00.000Z");
  });
});
