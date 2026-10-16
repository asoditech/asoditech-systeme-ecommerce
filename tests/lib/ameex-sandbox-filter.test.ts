import { describe, expect, it } from "vitest";
import { ameexAdapter, AMEEX_WEBHOOK_SANDBOX_TOPIC, AMEEX_WEBHOOK_TOPIC } from "@/lib/integrations/delivery/providers/ameex/adapter";

/** handleDeliveryWebhook's shouldIgnoreWebhookEvent hook, Ameex side (docs/adr/0060). */
describe("ameexAdapter.shouldIgnoreWebhookEvent", () => {
  const event = (topic: string) => ({ deliveryId: "d", topic, externalId: "SBX-1", rawStatus: "DELIVERED" });

  it("drops a sandbox event received on a live key", () => {
    expect(ameexAdapter.shouldIgnoreWebhookEvent!(event(AMEEX_WEBHOOK_SANDBOX_TOPIC), { apiId: "1", apiKey: "live_key_value" })).toMatch(/sandbox/i);
  });

  it("keeps a sandbox event on a test_ key, and a live event on a live key", () => {
    expect(ameexAdapter.shouldIgnoreWebhookEvent!(event(AMEEX_WEBHOOK_SANDBOX_TOPIC), { apiId: "1", apiKey: "test_abc" })).toBeNull();
    expect(ameexAdapter.shouldIgnoreWebhookEvent!(event(AMEEX_WEBHOOK_TOPIC), { apiId: "1", apiKey: "live_key_value" })).toBeNull();
  });

  it("never echoes the key in its reason", () => {
    const reason = ameexAdapter.shouldIgnoreWebhookEvent!(event(AMEEX_WEBHOOK_SANDBOX_TOPIC), { apiId: "1", apiKey: "live_secret_123" });
    expect(reason).not.toContain("live_secret_123");
  });
});
