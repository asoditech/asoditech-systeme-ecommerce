import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createProductAction, updateProductAction } from "@/actions/products";
import { setProductChannelsAction, addBarcodeAction, updateProductReferenceAction } from "@/actions/catalog";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { getConnectedCommercePlatforms } from "@/lib/integrations/shared";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * ADR 0017 (provider-owned product definition) vs ADR 0038 (store-only local
 * product). The approved boundary:
 *   - a product that lives on WooCommerce/Shopify stays provider-owned: its
 *     definition cannot be edited here;
 *   - an OFFLINE-only product has no provider, so it is created locally as a
 *     plain INTERNE product — and NEVER causes a call to any provider, on
 *     creation or when later made available online (no hidden provider creation).
 */

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
  await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  await prisma.integration.create({
    data: { provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: "https://shop.example.com" }, credentialsEncrypted: "iv:tag:x" },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string | string[]>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x);
    else f.set(k, v);
  }
  return f;
}

describe("store-only product while a store IS connected", () => {
  it("is created locally (INTERNE, no externalId), on the OFFLINE channel only, and never calls a provider", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect((await getConnectedCommercePlatforms()).length).toBeGreaterThan(0); // a store is connected
    const online = await ensureDefaultOnlineChannel();
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("a provider must never be called for a store-only product");
    });

    const r = await createProductAction(
      fd({ name: "Tote bag", sku: "TOTE-1", price: "60", status: "ACTIF", reference: "TOTE", barcode: "6119990000011", channelsSubmitted: "1", salesChannelIds: [store.id] })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const p = await prisma.product.findUniqueOrThrow({ where: { id: r.data.id }, include: { salesChannels: true, barcodes: true } });
    expect([p.source, p.externalId]).toEqual(["INTERNE", null]);
    expect(p.reference).toBe("TOTE");
    expect(p.barcodes.map((b) => b.code)).toEqual(["6119990000011"]);
    expect(p.salesChannels.map((c) => c.salesChannelId)).toEqual([store.id]);
    expect(p.salesChannels.some((c) => c.salesChannelId === online.id)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("making it available online later is only an availability row — still INTERNE, still no provider call", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const online = await ensureDefaultOnlineChannel();
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("no provider call expected");
    });
    const r = await createProductAction(fd({ name: "Tote bag", sku: "TOTE-2", price: "60", status: "ACTIF", channelsSubmitted: "1", salesChannelIds: [store.id] }));
    if (!r.ok) throw new Error("setup");

    expect((await setProductChannelsAction({ productId: r.data.id, salesChannelIds: [store.id, online.id] })).ok).toBe(true);

    const p = await prisma.product.findUniqueOrThrow({ where: { id: r.data.id } });
    expect([p.source, p.externalId]).toEqual(["INTERNE", null]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a store-only product is invisible to the storefront stock push (only source=WOOCOMMERCE with an externalId is pushed)", async () => {
    // Mirrors the selection in woocommerce/sync/stock-push.ts.
    await loginAsTestUser({ role: "ADMIN" });
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    await createProductAction(fd({ name: "Local", sku: "LOC-1", price: "10", status: "ACTIF", channelsSubmitted: "1", salesChannelIds: [store.id] }));
    const pushable = await prisma.product.findMany({ where: { source: "WOOCOMMERCE", externalId: { not: null }, trackInventory: true } });
    expect(pushable).toHaveLength(0);
  });
});

describe("provider-owned product keeps its ADR 0017 protection", () => {
  it("its definition cannot be edited here, while the ASODITECH-owned identity fields (barcode/reference) can", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const wooProduct = await prisma.product.create({
      data: { name: "Depuis Woo", sku: "WOO-1", price: 100, status: "ACTIF", source: "WOOCOMMERCE", externalId: "555" },
    });

    const edit = await updateProductAction(fd({ id: wooProduct.id, name: "Renommé", sku: "WOO-1", price: "1", status: "ACTIF" }));
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error).toMatch(/WooCommerce/);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: wooProduct.id } })).name).toBe("Depuis Woo");

    expect((await addBarcodeAction({ productId: wooProduct.id, code: "6118880000012" })).ok).toBe(true);
    expect((await updateProductReferenceAction({ productId: wooProduct.id, reference: "MODELE-W" })).ok).toBe(true);
  });
});
