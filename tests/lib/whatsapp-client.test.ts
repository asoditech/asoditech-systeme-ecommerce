import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Cloud API client (src/lib/whatsapp/client.ts) with `fetch` mocked —
 * no request ever leaves the process. `env` is pinned to a configured,
 * non-test environment with dummy values. docs/adr/0058.
 */

const env = vi.hoisted(() => ({
  NODE_ENV: "development",
  WHATSAPP_ACCESS_TOKEN: "dummy-token-not-real",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_GRAPH_API_VERSION: "v23.0",
}));
vi.mock("@/lib/env", () => ({ env }));

import { checkWhatsAppSender, isWhatsAppConfigured, sendTemplate, sendTemplateMessage } from "@/lib/whatsapp/client";
import { deliveryFailureSummaryTemplate, stockOutTemplate, verificationCodeTemplate } from "@/lib/whatsapp/templates";

const fetchMock = vi.fn();
beforeEach(() => {
  env.NODE_ENV = "development";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("sendTemplate", () => {
  it("posts one template message to the configured phone-number id with bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { messages: [{ id: "wamid.1" }] }));
    const result = await sendTemplate("212612345678", "asoditech_stock_out", "fr", ["Sac", "Magasin A"]);
    expect(result).toEqual({ ok: true, messageId: "wamid.1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer dummy-token-not-real");
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "212612345678",
      type: "template",
      template: {
        name: "asoditech_stock_out",
        language: { code: "fr" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Sac" }, { type: "text", text: "Magasin A" }] }],
      },
    });
  });

  it("verification code adds the copy-code button parameter", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { messages: [{ id: "wamid.2" }] }));
    await sendTemplateMessage("212612345678", verificationCodeTemplate("123456"));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.template.components[1]).toEqual({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] });
  });

  it("a Meta error or a network failure returns ok:false and logs no phone, body or token", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json(400, { error: { message: "Recipient 212612345678 not allowed", type: "OAuthException", code: 131030 } }));
    expect((await sendTemplate("212612345678", "asoditech_stock_out", "fr", ["Sac secret", "Magasin A"])).ok).toBe(false);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await sendTemplate("212612345678", "asoditech_stock_out", "fr", ["Sac secret", "Magasin A"])).ok).toBe(false);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("131030");
    for (const secret of ["212612345678", "Sac secret", "dummy-token-not-real"]) expect(logged).not.toContain(secret);
    log.mockRestore();
  });

  it("unconfigured, or under the test runner, sends nothing", async () => {
    env.NODE_ENV = "test";
    expect(isWhatsAppConfigured()).toBe(false);
    expect((await sendTemplate("212612345678", "asoditech_stock_out", "fr", ["a", "b"])).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("checkWhatsAppSender (« Tester la connexion »)", () => {
  it("GETs the sending number's public fields — never a message", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { display_phone_number: "+212 5 00", verified_name: "ASODITECH", quality_rating: "GREEN" }));
    expect(await checkWhatsAppSender()).toEqual({ ok: true, displayPhoneNumber: "+212 5 00", verifiedName: "ASODITECH" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v23.0/1234567890?fields=display_phone_number,verified_name,quality_rating");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("reports a rejected token as an error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: 190, type: "OAuthException" } }));
    const r = await checkWhatsAppSender();
    expect(r.ok).toBe(false);
  });
});

describe("templates", () => {
  it("names, parameter order, and Meta-safe parameters (no newlines)", () => {
    expect(stockOutTemplate({ productName: "Sac\nCuir   Noir", locationName: "Magasin A" })).toEqual({
      templateName: "asoditech_stock_out",
      parameters: ["Sac Cuir Noir", "Magasin A"],
    });
    expect(deliveryFailureSummaryTemplate({ count: 3, providerNames: ["Amana", "OzonExpress", "Amana"] })).toEqual({
      templateName: "asoditech_delivery_failure_summary",
      parameters: ["3", "Amana, OzonExpress"],
    });
  });
});
