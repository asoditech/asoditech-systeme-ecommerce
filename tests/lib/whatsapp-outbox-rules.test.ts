import { describe, expect, it } from "vitest";
import { WHATSAPP_ALERT_TYPES } from "@/lib/whatsapp/alert-types";
import {
  WHATSAPP_TEMPLATE_SPECS,
  deliveryFailureSummaryTemplate,
  integrationDownTemplate,
  newOrderTemplate,
  orderConfirmedTemplate,
  orderReturnedTemplate,
  stockLowTemplate,
  stockOutTemplate,
  templateForAlertType,
  verificationCodeTemplate,
} from "@/lib/whatsapp/templates";
import {
  IGNORE_REASONS,
  OUTBOX_EXPIRY_MS,
  OUTBOX_MAX_ATTEMPTS,
  classifySendError,
  decideAfterFailure,
  ignoreReason,
  isOutboxRowExpired,
  isTemplateSendable,
  parseEnabledTemplates,
  retryDelayMs,
  sanitizeOutboxError,
} from "@/lib/whatsapp/outbox-rules";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";

/**
 * Staff WhatsApp outbox — pure rules (docs/adr/0058 addendum, 2026-10-16).
 * No database, no network, no env: event → template mapping, the template
 * availability rule, failure classification / backoff, error sanitization,
 * IGNORE decisions and the cron bearer check.
 */

describe("event → template mapping", () => {
  it("every WhatsApp category has exactly one template, and the builders use the catalogue names", () => {
    const expected: Record<string, string> = {
      RUPTURE_STOCK: "asoditech_stock_out",
      ECHEC_LIVRAISON: "asoditech_delivery_failure_summary",
      ERREUR_INTEGRATION: "asoditech_integration_down",
      ECHEC_SYNCHRONISATION: "asoditech_integration_down",
      NOUVELLE_COMMANDE: "asoditech_new_order",
      COMMANDE_CONFIRMEE: "asoditech_order_confirmed",
      STOCK_FAIBLE: "asoditech_stock_low",
      COMMANDE_RETOURNEE: "asoditech_order_returned",
    };
    for (const type of WHATSAPP_ALERT_TYPES) {
      expect(WHATSAPP_TEMPLATE_SPECS.filter((t) => t.alertTypes.includes(type)), type).toHaveLength(1);
      expect(templateForAlertType(type).name, type).toBe(expected[type]);
    }
    const built = [
      stockOutTemplate({ productName: "Sac", locationName: "A" }),
      deliveryFailureSummaryTemplate({ count: 2, providerNames: ["Amana"] }),
      integrationDownTemplate({ label: "WooCommerce" }),
      newOrderTemplate({ orderNumber: "#1001", sourceLabel: "WooCommerce" }),
      orderConfirmedTemplate({ orderNumber: "#1001" }),
      stockLowTemplate({ productName: "Sac", available: 3, locationName: "A" }),
      orderReturnedTemplate({ orderNumber: "#1001" }),
      verificationCodeTemplate("123456"),
    ];
    for (const m of built) {
      const spec = WHATSAPP_TEMPLATE_SPECS.find((t) => t.name === m.templateName);
      expect(spec, m.templateName).toBeDefined();
      expect(m.parameters, m.templateName).toHaveLength(spec!.parameters.length);
    }
  });

  it("new templates carry no price, customer data or line breaks", () => {
    const m = stockLowTemplate({ productName: "Sac\ncuir\t  rouge", available: 2.9, locationName: "Magasin  A" });
    expect(m.parameters).toEqual(["Sac cuir rouge", "2", "Magasin A"]);
    expect(newOrderTemplate({ orderNumber: "#1", sourceLabel: "Shopify" }).parameters).toEqual(["#1", "Shopify"]);
    expect(stockLowTemplate({ productName: "x", available: -4, locationName: "y" }).parameters[1]).toBe("0");
  });
});

describe("template availability", () => {
  it("the four V1 templates are always sendable (backward compatible)", () => {
    for (const name of ["asoditech_stock_out", "asoditech_delivery_failure_summary", "asoditech_integration_down", "asoditech_verification_code"]) {
      expect(isTemplateSendable(name, new Set()), name).toBe(true);
    }
  });

  it("a new template is sendable only when listed in WHATSAPP_ENABLED_TEMPLATES", () => {
    expect(isTemplateSendable("asoditech_new_order", new Set())).toBe(false);
    const enabled = parseEnabledTemplates(" asoditech_new_order , asoditech_stock_low,, BAD NAME ");
    expect([...enabled]).toEqual(["asoditech_new_order", "asoditech_stock_low"]);
    expect(isTemplateSendable("asoditech_new_order", enabled)).toBe(true);
    expect(isTemplateSendable("asoditech_order_returned", enabled)).toBe(false);
    expect(parseEnabledTemplates(undefined).size).toBe(0);
  });
});

describe("IGNORE decisions", () => {
  const ok = {
    templateName: "asoditech_stock_out",
    enabledTemplates: new Set<string>(),
    tenantEnabled: true,
    alertType: "RUPTURE_STOCK",
    companyDisabled: [] as string[],
    recipientReady: true,
    userMuted: [] as string[],
  };
  it("sendable → null; each blocking fact → its own reason", () => {
    expect(ignoreReason(ok)).toBeNull();
    expect(ignoreReason({ ...ok, templateName: "asoditech_new_order", alertType: "NOUVELLE_COMMANDE" })).toBe(
      IGNORE_REASONS.templateNotEnabled("asoditech_new_order")
    );
    expect(IGNORE_REASONS.templateNotEnabled("x")).toMatch(/non approuvé\/configuré/);
    expect(ignoreReason({ ...ok, tenantEnabled: false })).toBe(IGNORE_REASONS.tenantDisabled);
    expect(ignoreReason({ ...ok, companyDisabled: ["RUPTURE_STOCK"] })).toBe(IGNORE_REASONS.categoryDisabled);
    expect(ignoreReason({ ...ok, recipientReady: false })).toBe(IGNORE_REASONS.recipientNotReady);
    expect(ignoreReason({ ...ok, userMuted: ["RUPTURE_STOCK"] })).toBe(IGNORE_REASONS.userMuted);
    // Another category's switch does not matter.
    expect(ignoreReason({ ...ok, companyDisabled: ["STOCK_FAIBLE"], userMuted: ["ECHEC_LIVRAISON"] })).toBeNull();
  });

  it("a configuration problem (template) is reported before any business fact", () => {
    expect(
      ignoreReason({ ...ok, templateName: "asoditech_stock_low", tenantEnabled: false, recipientReady: false })
    ).toBe(IGNORE_REASONS.templateNotEnabled("asoditech_stock_low"));
  });
});

describe("failure classification, backoff and status decisions", () => {
  it("network / timeout / 5xx / 429 / Meta rate-limit codes are transient; other 4xx are permanent", () => {
    expect(classifySendError("TimeoutError")).toBe("transient");
    expect(classifySendError("TypeError")).toBe("transient");
    expect(classifySendError("HTTP 500")).toBe("transient");
    expect(classifySendError("HTTP 503 code=? type=?")).toBe("transient");
    expect(classifySendError("HTTP 429")).toBe("transient");
    expect(classifySendError("HTTP 400 code=130429 type=OAuthException")).toBe("transient");
    expect(classifySendError("HTTP 400 code=131056 type=OAuthException")).toBe("transient");
    expect(classifySendError("HTTP 400")).toBe("permanent");
    expect(classifySendError("HTTP 404 code=132001 type=OAuthException")).toBe("permanent");
    expect(classifySendError("HTTP 401 code=190 type=OAuthException")).toBe("permanent");
    expect(classifySendError("recipient_not_allowed")).toBe("ignore");
  });

  it("exponential backoff, capped", () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 240_000, 960_000, 3_840_000]);
    expect(retryDelayMs(20)).toBe(6 * 60 * 60_000);
    expect(retryDelayMs(0)).toBe(60_000);
  });

  it("transient → EN_ATTENTE with backoff until the max, then ECHEC; permanent → ECHEC at once", () => {
    const now = new Date("2026-10-16T10:00:00Z");
    const first = decideAfterFailure({ attempts: 1, error: "HTTP 503", now });
    expect(first).toMatchObject({ status: "EN_ATTENTE" });
    expect(first.status === "EN_ATTENTE" && first.nextAttemptAt.toISOString()).toBe("2026-10-16T10:01:00.000Z");
    expect(decideAfterFailure({ attempts: OUTBOX_MAX_ATTEMPTS - 1, error: "TimeoutError", now }).status).toBe("EN_ATTENTE");
    const last = decideAfterFailure({ attempts: OUTBOX_MAX_ATTEMPTS, error: "TimeoutError", now });
    expect(last.status).toBe("ECHEC");
    expect(last.lastError).toContain(`${OUTBOX_MAX_ATTEMPTS} tentatives`);
    const refused = decideAfterFailure({ attempts: 1, error: "HTTP 400 code=132001 type=OAuthException", now });
    expect(refused).toEqual({ status: "ECHEC", lastError: "Refus définitif de Meta (HTTP 400 code=132001 type=OAuthException)." });
    expect(decideAfterFailure({ attempts: 1, error: "recipient_not_allowed", now }).status).toBe("IGNORE");
  });

  it("expiry after 24 h", () => {
    const now = new Date();
    expect(isOutboxRowExpired(new Date(now.getTime() - OUTBOX_EXPIRY_MS - 1), now)).toBe(true);
    expect(isOutboxRowExpired(new Date(now.getTime() - 60_000), now)).toBe(false);
  });
});

describe("error sanitization", () => {
  it("never keeps a token, a phone number or a line break; keeps Meta's code", () => {
    const raw = "HTTP 400 code=131026 type=OAuthException to +212 612-345-678 Bearer EAAGabcdefghijklmnop\nparam: Sac";
    const clean = sanitizeOutboxError(raw);
    expect(clean).toContain("code=131026");
    expect(clean).not.toMatch(/612|345|678/);
    expect(clean).not.toContain("EAAG");
    expect(clean).not.toContain("\n");
    expect(sanitizeOutboxError("212612345678")).toBe("•••");
    expect(sanitizeOutboxError("x".repeat(500))).toHaveLength(200);
    const decided = decideAfterFailure({ attempts: 1, error: "HTTP 400 for 212612345678", now: new Date() });
    expect(decided.lastError).not.toContain("212612345678");
  });
});

describe("cron bearer check", () => {
  it("refuses when no secret is configured, a wrong or missing bearer; accepts the exact secret", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret-value", undefined)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest(null, "s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("s3cret-value", "s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cret-valuX", "s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret-value")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cret-value", "s3cret-value")).toBe(true);
  });
});
