import { describe, expect, it, vi } from "vitest";
import { runSyncLoop } from "@/lib/integrations/shared/sync-loop";
import { historicalCutoff, unsupportedStatusNote } from "@/lib/integrations/shared/integration-config";
import { isUnsupportedOrderStatus, mapOrderStatus } from "@/lib/integrations/woocommerce/mapper";
import { WHATSAPP_ALERT_TYPES, isWhatsAppAlertMuted, isWhatsAppAlertType, nextMutedAlerts } from "@/lib/whatsapp/alert-types";
import { ALERT_RULES } from "@/lib/notification-settings";

/**
 * Pure rules of the 2026-10-12 sync / WhatsApp hardening (no database):
 * the client sync loop, the optional history cutoff, the aggregated
 * « statut non pris en charge » note, and the per-alert WhatsApp mutes.
 */

const noSleep = { sleep: async () => {} };

describe("runSyncLoop — one click runs every capped batch", () => {
  it("re-invokes while hasMore, reports every batch, stops when done", async () => {
    const batches = [{ more: true }, { more: true }, { more: false }];
    const step = vi.fn(async (i: number) => ({ ok: true as const, data: batches[i]! }));
    const seen: number[] = [];
    const out = await runSyncLoop(step, (d) => d.more, (_d, i) => seen.push(i), noSleep);
    expect(out).toEqual({ ok: true, iterations: 3, stoppedAtCap: false });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("an error stops the loop and is reported (earlier batches already counted)", async () => {
    let calls = 0;
    const out = await runSyncLoop(
      async () => (++calls === 2 ? { ok: false as const, error: "Synchronisation déjà en cours" } : { ok: true as const, data: { more: true } }),
      (d) => d.more,
      () => {},
      noSleep
    );
    expect(out).toEqual({ ok: false, error: "Synchronisation déjà en cours", iterations: 2 });
  });

  it("a backlog that never ends stops at the safety cap and says so", async () => {
    const out = await runSyncLoop(async () => ({ ok: true as const, data: { more: true } }), (d) => d.more, () => {}, { ...noSleep, maxIterations: 4 });
    expect(out).toEqual({ ok: true, iterations: 4, stoppedAtCap: true });
  });
});

describe("historical backfill cutoff (Integration.config)", () => {
  it("default / ON: no cutoff (unchanged behavior)", () => {
    expect(historicalCutoff(null)).toBeNull();
    expect(historicalCutoff({})).toBeNull();
    expect(historicalCutoff({ importHistoricalOrders: true, historyCutoffAt: "2026-10-01T00:00:00Z" })).toBeNull();
  });

  it("OFF: the stored moment; a missing or garbled date means no cutoff", () => {
    expect(historicalCutoff({ importHistoricalOrders: false, historyCutoffAt: "2026-10-01T00:00:00.000Z" })?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(historicalCutoff({ importHistoricalOrders: false })).toBeNull();
    expect(historicalCutoff({ importHistoricalOrders: false, historyCutoffAt: "pas une date" })).toBeNull();
  });
});

describe("unsupported WooCommerce statuses are counted, never guessed", () => {
  it("a plugin status is unsupported; mapped and draft/trash statuses are not", () => {
    expect(isUnsupportedOrderStatus("shipped")).toBe(true);
    expect(isUnsupportedOrderStatus("wc-delivered")).toBe(true);
    for (const s of ["pending", "processing", "completed", "cancelled", "refunded", "failed", "on-hold", "trash", "checkout-draft"]) {
      expect(isUnsupportedOrderStatus(s), s).toBe(false);
    }
    expect(isUnsupportedOrderStatus("toString")).toBe(true); // no prototype leak
    expect(mapOrderStatus("toString").ok).toBe(false);
  });

  it("one aggregated note per run", () => {
    expect(unsupportedStatusNote("WooCommerce", new Map())).toBeNull();
    expect(unsupportedStatusNote("WooCommerce", new Map([["shipped", 2], ["delivered", 1]]))).toBe(
      "3 commande(s) ignorée(s) : statut WooCommerce non pris en charge (shipped ×2, delivered)."
    );
  });
});

describe("per-alert WhatsApp mutes (User.whatsappMutedAlerts)", () => {
  it("only alert types with an approved template can be muted", () => {
    expect([...WHATSAPP_ALERT_TYPES]).toEqual(["RUPTURE_STOCK", "ECHEC_LIVRAISON", "ERREUR_INTEGRATION", "ECHEC_SYNCHRONISATION"]);
    expect(isWhatsAppAlertType("COMMANDE_RETOURNEE")).toBe(false);
    expect(isWhatsAppAlertType("STOCK_FAIBLE")).toBe(false);
  });

  it("mute / unmute: known types only, no duplicates, stable order", () => {
    expect(nextMutedAlerts([], "ECHEC_SYNCHRONISATION", true)).toEqual(["ECHEC_SYNCHRONISATION"]);
    expect(nextMutedAlerts(["ECHEC_SYNCHRONISATION", "junk"], "RUPTURE_STOCK", true)).toEqual(["RUPTURE_STOCK", "ECHEC_SYNCHRONISATION"]);
    expect(nextMutedAlerts(["RUPTURE_STOCK", "RUPTURE_STOCK"], "RUPTURE_STOCK", true)).toEqual(["RUPTURE_STOCK"]);
    expect(nextMutedAlerts(["RUPTURE_STOCK", "ECHEC_LIVRAISON"], "RUPTURE_STOCK", false)).toEqual(["ECHEC_LIVRAISON"]);
  });

  it("a muted type is not sent; an untyped message is never muted", () => {
    expect(isWhatsAppAlertMuted(["RUPTURE_STOCK"], "RUPTURE_STOCK")).toBe(true);
    expect(isWhatsAppAlertMuted(["RUPTURE_STOCK"], "ECHEC_LIVRAISON")).toBe(false);
    expect(isWhatsAppAlertMuted(["RUPTURE_STOCK"], undefined)).toBe(false);
    expect(isWhatsAppAlertMuted(null, "RUPTURE_STOCK")).toBe(false);
  });

  it("the settings page stays honest: every WhatsApp alert row is mutable, and only those", () => {
    for (const rule of ALERT_RULES) {
      if (rule.channels.includes("whatsapp")) expect(rule.whatsappType, rule.key).toBeDefined();
      else expect(rule.whatsappType, rule.key).toBeUndefined();
    }
    expect(new Set(ALERT_RULES.flatMap((r) => (r.whatsappType ? [r.whatsappType] : [])))).toEqual(new Set(WHATSAPP_ALERT_TYPES));
  });
});
