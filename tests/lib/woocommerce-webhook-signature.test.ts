import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, generateWebhookSecret } from "@/lib/integrations/woocommerce/webhook-signature";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ id: 123, status: "processing" });

  it("accepts a correctly computed signature", () => {
    expect(verifyWebhookSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    expect(verifyWebhookSignature(body, sign(body, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects a signature computed over a different (tampered) body", () => {
    const tampered = JSON.stringify({ id: 123, status: "cancelled" });
    expect(verifyWebhookSignature(tampered, sign(body, secret), secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
  });

  it("rejects a garbage signature header without throwing", () => {
    expect(verifyWebhookSignature(body, "not-base64-!!!", secret)).toBe(false);
  });
});

describe("generateWebhookSecret", () => {
  it("generates a long, non-empty, unique secret each time", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });
});
