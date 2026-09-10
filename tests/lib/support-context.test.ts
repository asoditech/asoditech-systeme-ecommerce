import { describe, expect, it } from "vitest";
import { resolveSupportContext, buildSupportMessage } from "@/lib/support/context";

describe("resolveSupportContext", () => {
  it("recognises the dashboard and features today's figures", () => {
    const ctx = resolveSupportContext("/tableau-de-bord");
    expect(ctx.area).toBe("dashboard");
    expect(ctx.featuredActionIds).toEqual(["profit-today", "revenue-today", "orders-today"]);
    expect(ctx.entity).toBeUndefined();
  });

  it("captures the order id on an order detail page", () => {
    const ctx = resolveSupportContext("/commandes/clx0abcdef1234567890xyz");
    expect(ctx.area).toBe("orders");
    expect(ctx.entity).toEqual({ type: "Order", id: "clx0abcdef1234567890xyz" });
    expect(ctx.label).toBe("cette commande");
    expect(ctx.reportCategory).toBe("commande");
  });

  it("does not capture an entity on the orders list", () => {
    const ctx = resolveSupportContext("/commandes");
    expect(ctx.area).toBe("orders");
    expect(ctx.entity).toBeUndefined();
  });

  it("captures the shipment id on a tracking detail page", () => {
    const ctx = resolveSupportContext("/livraison/suivi/clx0shipmentaaaaaaaaaa");
    expect(ctx.area).toBe("delivery");
    expect(ctx.entity).toEqual({ type: "Shipment", id: "clx0shipmentaaaaaaaaaa" });
    expect(ctx.featuredActionIds).toContain("deliveries-in-transit");
  });

  it("maps the delivery area from any /livraison path", () => {
    expect(resolveSupportContext("/livraison").area).toBe("delivery");
    expect(resolveSupportContext("/livraison/suivi").area).toBe("delivery");
  });

  it("maps catalogue and finance areas", () => {
    expect(resolveSupportContext("/produits").area).toBe("catalogue");
    expect(resolveSupportContext("/stock").area).toBe("catalogue");
    expect(resolveSupportContext("/finance").area).toBe("finance");
    expect(resolveSupportContext("/depenses").area).toBe("finance");
  });

  it("falls back to a generic context for an unknown path", () => {
    const ctx = resolveSupportContext("/parametres/sauvegarde");
    expect(ctx.area).toBe("generic");
    expect(ctx.featuredActionIds.length).toBeGreaterThan(0);
  });

  it("ignores a trailing slash and query string", () => {
    expect(resolveSupportContext("/tableau-de-bord/?x=1").area).toBe("dashboard");
  });
});

describe("buildSupportMessage", () => {
  it("includes the company name and the current screen", () => {
    const msg = buildSupportMessage({
      companyName: "100 D ryal",
      context: resolveSupportContext("/tableau-de-bord"),
    });
    expect(msg).toContain("100 D ryal");
    expect(msg).toContain("le tableau de bord");
  });

  it("includes the order reference when viewing an order", () => {
    const msg = buildSupportMessage({
      companyName: "ASODITECH",
      context: resolveSupportContext("/commandes/clx0abcdef1234567890xyz"),
      pageUrl: "/commandes/clx0abcdef1234567890xyz",
    });
    expect(msg).toContain("Commande : clx0abcdef1234567890xyz");
    expect(msg).toContain("Page : /commandes/clx0abcdef1234567890xyz");
  });

  it("never leaks anything beyond company / screen / page — no secrets", () => {
    const msg = buildSupportMessage({
      companyName: "ASODITECH",
      context: resolveSupportContext("/finance"),
    });
    expect(msg).toBe("Bonjour, j'ai besoin d'aide concernant ASODITECH.\nÉcran : les finances.");
  });
});
