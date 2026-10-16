import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { connectIntegrationAction, disconnectIntegrationAction } from "@/actions/integrations";
import { inventoryOwnerOf, remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { FAKE_CONSUMER_KEY, FAKE_CONSUMER_SECRET, FAKE_STORE_URL, emptyFakeStore, installFakeWooCommerceServer } from "../helpers/fake-woocommerce";
import { FAKE_ACCESS_TOKEN, FAKE_SHOP_DOMAIN, emptyFakeShopifyStore, installFakeShopifyServer } from "../helpers/fake-shopify";

/**
 * Re-saving a store connection (key rotation, « Modifier », disconnect then
 * reconnect) — `connectIntegrationAction` upserts the SAME Integration row.
 * Owner decision (2026-10-13): the company's valid per-connection choices
 * survive when the store is the same one (same validated address); a
 * DIFFERENT store never inherits them and starts from the safe defaults.
 * Sync cursors are working state and restart either way. Local fakes only.
 */

const CHOICES = {
  remoteDeletionMode: "auto",
  inventoryOwner: "STORE",
  importHistoricalOrders: false,
  historyCutoffAt: "2026-10-01T00:00:00.000Z",
  forceNouvelleOnImport: false,
};
const CURSORS = { productsResumePage: 3, productsResumeOffset: 5, ordersResumePage: 2 };

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const connectWoo = (siteUrl = FAKE_STORE_URL, apiKey = FAKE_CONSUMER_KEY) =>
  connectIntegrationAction(form({ provider: "WOOCOMMERCE", siteUrl, apiKey, apiSecret: FAKE_CONSUMER_SECRET }));
const connectShopify = (siteUrl = FAKE_SHOP_DOMAIN) => connectIntegrationAction(form({ provider: "SHOPIFY", siteUrl, apiKey: FAKE_ACCESS_TOKEN, apiSecret: "" }));
const lastConnectAudit = async (provider: "WOOCOMMERCE" | "SHOPIFY") => {
  const row = await prisma.integration.findFirstOrThrow({ where: { provider } });
  return (await prisma.auditEvent.findFirstOrThrow({ where: { entityId: row.id, action: "integration.connected" }, orderBy: { createdAt: "desc" } })).newValue;
};
const configOf = async (provider: "WOOCOMMERCE" | "SHOPIFY") =>
  (await prisma.integration.findFirstOrThrow({ where: { provider } })).config as Record<string, unknown>;
async function choose(provider: "WOOCOMMERCE" | "SHOPIFY", extra: Record<string, unknown> = {}) {
  const row = await prisma.integration.findFirstOrThrow({ where: { provider } });
  await prisma.integration.update({ where: { id: row.id }, data: { config: { ...(row.config as object), ...CHOICES, ...CURSORS, ...extra } } });
  return row.id;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "true");
  installFakeWooCommerceServer(emptyFakeStore());
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("WooCommerce: re-saving the connection", () => {
  it("same store (rotated key): same row, every audited choice kept, cursors restart, the change is audited", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect(await connectWoo()).toMatchObject({ ok: true });
    const id = await choose("WOOCOMMERCE");

    expect(await connectWoo(FAKE_STORE_URL, "ck_rotated_key")).toEqual({ ok: true, data: { id } });
    const config = await configOf("WOOCOMMERCE");
    expect(config).toMatchObject({ siteUrl: expect.any(String), ...CHOICES });
    for (const cursor of Object.keys(CURSORS)) expect(config[cursor]).toBeUndefined();
    expect(remoteDeletionModeOf(config)).toBe("auto");
    expect(inventoryOwnerOf(config)).toBe("STORE");
    expect(await lastConnectAudit("WOOCOMMERCE")).toEqual({ provider: "WOOCOMMERCE", storeAddress: "same", keptSettings: Object.keys(CHOICES).sort(), initializedSettings: [] });
  });

  it("first connection: everything starts from the defaults, and the audit says so", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectWoo();
    expect(await lastConnectAudit("WOOCOMMERCE")).toEqual({
      provider: "WOOCOMMERCE",
      storeAddress: "new",
      keptSettings: [],
      initializedSettings: ["remoteDeletionMode", "inventoryOwner", "importHistoricalOrders", "historyCutoffAt", "forceNouvelleOnImport"],
    });
  });

  it("the same store typed differently (case, trailing slash) is the same store", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectWoo();
    await choose("WOOCOMMERCE");
    await connectWoo("https://EXAMPLE.com/");
    expect(await configOf("WOOCOMMERCE")).toMatchObject(CHOICES);
    expect(await lastConnectAudit("WOOCOMMERCE")).toMatchObject({ storeAddress: "same" });
  });

  it("disconnect then reconnect to the same store keeps the choices too", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectWoo();
    await choose("WOOCOMMERCE");
    expect(await disconnectIntegrationAction(form({ provider: "WOOCOMMERCE" }))).toMatchObject({ ok: true });
    await connectWoo();
    expect(await configOf("WOOCOMMERCE")).toMatchObject(CHOICES);
  });

  it("a different store address never inherits the old store's choices: safe defaults (manual unlinking, ASODITECH stock, history imported, first import NOUVELLE)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectWoo();
    const id = await choose("WOOCOMMERCE");
    expect(await connectWoo("https://example.org")).toEqual({ ok: true, data: { id } }); // same row, new store
    const config = await configOf("WOOCOMMERCE");
    expect(config).toEqual({ siteUrl: "https://example.org" });
    expect(remoteDeletionModeOf(config)).toBe("manual");
    expect(inventoryOwnerOf(config)).toBe("ASODITECH");
    expect(await lastConnectAudit("WOOCOMMERCE")).toEqual({
      provider: "WOOCOMMERCE",
      storeAddress: "changed",
      keptSettings: [],
      initializedSettings: ["remoteDeletionMode", "inventoryOwner", "importHistoricalOrders", "historyCutoffAt", "forceNouvelleOnImport"],
    });

    // switching back to the first store does not bring the old choices back either
    await connectWoo();
    expect(inventoryOwnerOf(await configOf("WOOCOMMERCE"))).toBe("ASODITECH");
  });

  it("invalid stored values are dropped (their safe default applies), valid ones kept — and the audit tells which", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectWoo();
    await choose("WOOCOMMERCE", { remoteDeletionMode: "AUTO!", inventoryOwner: "BOTH", importHistoricalOrders: "no", historyCutoffAt: "hier" });
    await connectWoo();
    const config = await configOf("WOOCOMMERCE");
    expect(config).toEqual({ siteUrl: "https://example.com", forceNouvelleOnImport: false });
    expect(remoteDeletionModeOf(config)).toBe("manual");
    expect(inventoryOwnerOf(config)).toBe("ASODITECH");
    expect(await lastConnectAudit("WOOCOMMERCE")).toEqual({
      provider: "WOOCOMMERCE",
      storeAddress: "same",
      keptSettings: ["forceNouvelleOnImport"],
      initializedSettings: ["remoteDeletionMode", "inventoryOwner", "importHistoricalOrders", "historyCutoffAt"],
    });
  });

  it("another company's connection is never read or changed; a refused request changes nothing", async () => {
    const TENANT_B = "tenant-b-reconnect";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const b = await prismaBase.integration.create({ data: { tenantId: TENANT_B, provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: FAKE_STORE_URL, ...CHOICES } } });

    await loginAsTestUser({ role: "ADMIN" });
    await connectWoo();
    expect(await configOf("WOOCOMMERCE")).not.toHaveProperty("inventoryOwner"); // A starts clean: B's choices never leak
    expect((await prismaBase.integration.findUniqueOrThrow({ where: { id: b.id } })).config).toMatchObject(CHOICES);

    await choose("WOOCOMMERCE");
    await loginAsTestUser({ role: "MANAGER" });
    await expect(connectWoo("https://example.org")).rejects.toThrow(/autoris|permission/i);
    expect(await configOf("WOOCOMMERCE")).toMatchObject(CHOICES);
  });
});

describe("Shopify: re-saving the connection", () => {
  beforeEach(() => installFakeShopifyServer(emptyFakeShopifyStore()));
  // « Que faire lorsqu'un produit est supprimé ? » is a Shopify choice too since 2026-10-15 (shared/remote-deletion.ts).
  const SHOPIFY_CHOICES = { remoteDeletionMode: "auto", inventoryOwner: "STORE", importHistoricalOrders: false, historyCutoffAt: CHOICES.historyCutoffAt, forceNouvelleOnImport: false };

  it("same shop (rotated token, disconnect + reconnect): « Qui gère le stock ? » and the order choices kept, cursors restart", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect(await connectShopify()).toMatchObject({ ok: true });
    await choose("SHOPIFY", { productsResumeCursor: "abc" });
    await connectShopify();
    expect(await configOf("SHOPIFY")).toEqual({ shopDomain: expect.any(String), ...SHOPIFY_CHOICES });
    expect(await lastConnectAudit("SHOPIFY")).toEqual({ provider: "SHOPIFY", storeAddress: "same", keptSettings: Object.keys(SHOPIFY_CHOICES).sort(), initializedSettings: [] });

    expect(await disconnectIntegrationAction(form({ provider: "SHOPIFY" }))).toMatchObject({ ok: true });
    await connectShopify();
    expect(inventoryOwnerOf(await configOf("SHOPIFY"))).toBe("STORE");
  });

  it("another shop never inherits: safe defaults (ASODITECH stock)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectShopify();
    await choose("SHOPIFY");
    await connectShopify("https://autre-boutique.myshopify.com");
    const config = await configOf("SHOPIFY");
    expect(config).toEqual({ shopDomain: expect.stringContaining("autre-boutique") });
    expect(inventoryOwnerOf(config)).toBe("ASODITECH");
    expect(await lastConnectAudit("SHOPIFY")).toMatchObject({ storeAddress: "changed", keptSettings: [] });
  });

  it("refused without integrations.manage, and while Shopify is switched off — nothing changes", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await connectShopify();
    await choose("SHOPIFY");
    await loginAsTestUser({ role: "MANAGER" });
    await expect(connectShopify("https://autre-boutique.myshopify.com")).rejects.toThrow(/autoris|permission/i);
    await loginAsTestUser({ role: "ADMIN" });
    vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", "false");
    expect(await connectShopify("https://autre-boutique.myshopify.com")).toMatchObject({ ok: false });
    expect(await configOf("SHOPIFY")).toMatchObject({ inventoryOwner: "STORE" });
  });
});
