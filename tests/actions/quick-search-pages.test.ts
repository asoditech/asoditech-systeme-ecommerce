import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { quickSearchAction } from "@/actions/search";
import { matchPages, normalizeForSearch } from "@/lib/navigation/page-search";
import { createLatestGate } from "@/lib/latest-request";
import { DEFAULT_TENANT_ID, resetDb, setTestBusinessMode } from "../helpers/db";
import { grantChannelAccess, grantLocationAccess, loginAsTestUser } from "../helpers/auth";

/**
 * S7 — ONE global search: pages and reports by the sidebar's own permission
 * rules, returned parcels by the workspace's own permission + location rule,
 * tenant-isolated, and only the newest query's answer is ever shown.
 */
const A = DEFAULT_TENANT_ID;
const B = "tenant-b-quick-search-pages";

const pageTitles = async (q: string) => (await quickSearchAction(q)).filter((r) => r.type === "page").map((r) => r.title);
const returnHits = async (q: string) => (await quickSearchAction(q)).filter((r) => r.type === "return");

describe("page matching (pure)", () => {
  const pages = [
    { href: "/depenses", label: "Dépenses", group: "Pilotage" },
    { href: "/livraison/suivi", label: "Suivi", group: "Ventes" },
    { href: "/livraison/factures", label: "Factures de livraison", group: "Rapports" },
    { href: "/livraison", label: "Livraison", group: "Ventes" },
  ];

  it("ignores case and accents; every word must start a word of the label or group", () => {
    expect(normalizeForSearch("  Dépenses & Charges ")).toBe("depenses charges");
    expect(matchPages(pages, "DEPENSES").map((p) => p.href)).toEqual(["/depenses"]);
    expect(matchPages(pages, "fac liv").map((p) => p.href)).toEqual(["/livraison/factures"]);
    expect(matchPages(pages, "penses")).toEqual([]); // not a word start
    expect(matchPages(pages, "   ")).toEqual([]);
  });

  it("a label that starts with the query ranks before a group / later-word match", () => {
    expect(matchPages(pages, "liv").map((p) => p.href)).toEqual(["/livraison", "/livraison/factures"]);
    expect(matchPages(pages, "ventes", 1)).toHaveLength(1);
  });
});

describe("latest request wins (pure)", () => {
  it("an older response is dropped once a newer request started, or after cancel", () => {
    const gate = createLatestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isLatest(first)).toBe(false); // the slow first answer arrives late → ignored
    expect(gate.isLatest(second)).toBe(true);
    gate.cancel(); // query cleared / dialog closed
    expect(gate.isLatest(second)).toBe(false);
  });
});

describe("quickSearchAction — pages, reports and returned parcels", () => {
  beforeEach(async () => {
    await resetDb();
    await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
  });
  afterEach(resetDb);

  it("offers only pages and reports the user may open", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    expect(await pageTitles("dépenses")).toEqual(["Dépenses"]);
    expect(await pageTitles("treso")).toContain("Trésorerie");
    expect(await pageTitles("suivi")).toContain("Suivi");

    await loginAsTestUser({ role: "CONFIRMATION" }); // no finance / analytics / delivery
    expect(await pageTitles("dépenses")).toEqual([]);
    expect(await pageTitles("treso")).toEqual([]);
    expect(await pageTitles("suivi")).toEqual([]);
    expect(await pageTitles("confirmation")).toEqual(["Confirmation"]);
  });

  it("finds a returned parcel by its tracking number — with the right permission, location and tenant only", async () => {
    const warehouse = await prismaBase.warehouse.create({ data: { tenantId: A, name: "Principal", isDefault: true } });
    const customer = await prismaBase.customer.create({ data: { tenantId: A, fullName: "Client" } });
    const order = await prismaBase.order.create({
      data: {
        tenantId: A,
        customerId: customer.id,
        subtotal: 100,
        total: 100,
        status: "EXPEDIEE",
        shippedAt: new Date(),
        fulfillmentWarehouseId: warehouse.id,
        items: { create: [{ tenantId: A, nameSnapshot: "Article", skuSnapshot: "ART", unitPrice: 100, quantity: 1, total: 100 }] },
      },
    });
    const provider = await prismaBase.shippingProvider.create({ data: { tenantId: A, name: "Ozon" } });
    await prismaBase.shipment.create({ data: { tenantId: A, orderId: order.id, providerId: provider.id, trackingNumber: "RET-123", status: "RETOURNE" } });
    await prismaBase.shipment.create({ data: { tenantId: A, orderId: order.id, providerId: provider.id, trackingNumber: "MOVE-1", status: "EN_TRANSIT" } });
    // Tenant B: the same tracking shape.
    const wB = await prismaBase.warehouse.create({ data: { tenantId: B, name: "B", isDefault: true } });
    const cB = await prismaBase.customer.create({ data: { tenantId: B, fullName: "B" } });
    const oB = await prismaBase.order.create({ data: { tenantId: B, customerId: cB.id, subtotal: 1, total: 1, status: "EXPEDIEE", shippedAt: new Date(), fulfillmentWarehouseId: wB.id } });
    const pB = await prismaBase.shippingProvider.create({ data: { tenantId: B, name: "P" } });
    await prismaBase.shipment.create({ data: { tenantId: B, orderId: oB.id, providerId: pB.id, trackingNumber: "RET-B", status: "RETOURNE" } });

    const manager = await loginAsTestUser({ role: "MANAGER" }); // orders.return, but no location yet
    expect(await returnHits("RET-123")).toEqual([]);
    await grantLocationAccess(manager.id, warehouse.id);
    const hits = await returnHits("ret-123");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: "Colis retourné RET-123", href: "/livraison/retours?q=RET-123" });
    expect(hits[0].subtitle).toContain("À réceptionner");
    expect(await returnHits("MOVE-1")).toEqual([]); // not a returned parcel
    expect(await returnHits("RET-B")).toEqual([]); // another tenant's

    await loginAsTestUser({ role: "CONFIRMATION" }); // no orders.return
    expect(await returnHits("RET-123")).toEqual([]);
  });

  it("finds a returned parcel by the order number the tenant SEES — never by a hidden global number", async () => {
    const warehouse = await prismaBase.warehouse.create({ data: { tenantId: A, name: "Principal", isDefault: true } });
    const provider = await prismaBase.shippingProvider.create({ data: { tenantId: A, name: "Ozon" } });
    async function returnedOrder(displayNumber: number, orderNumber: number, trackingNumber: string) {
      const customer = await prismaBase.customer.create({ data: { tenantId: A, fullName: `Client ${trackingNumber}` } });
      const o = await prismaBase.order.create({
        data: {
          tenantId: A,
          customerId: customer.id,
          orderNumber,
          displayNumber,
          subtotal: 100,
          total: 100,
          status: "EXPEDIEE",
          shippedAt: new Date(),
          fulfillmentWarehouseId: warehouse.id,
          items: { create: [{ tenantId: A, nameSnapshot: "Article", skuSnapshot: "ART", unitPrice: 100, quantity: 1, total: 100 }] },
        },
      });
      await prismaBase.shipment.create({ data: { tenantId: A, orderId: o.id, providerId: provider.id, trackingNumber, status: "RETOURNE" } });
    }
    await returnedOrder(140, 960_001, "SHOWN-140"); // displayed as CMD-000140
    await returnedOrder(7, 140, "GLOBAL-140"); // hidden global number 140, displayed as CMD-000007

    await loginAsTestUser({ role: "ADMIN" }); // orders.return, global locations
    for (const q of ["CMD-000140", "140"]) {
      expect((await returnHits(q)).map((h) => h.title), q).toEqual(["Colis retourné SHOWN-140"]);
    }
    expect((await returnHits("CMD-000007")).map((h) => h.title)).toEqual(["Colis retourné GLOBAL-140"]);
  });
});

describe("quickSearchAction — each section needs its own view permission", () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  const hitsOf = async (q: string, type: string) => (await quickSearchAction(q)).filter((r) => r.type === type);
  const deny = (userId: string, permission: string) =>
    prismaBase.userPermissionOverride.create({ data: { tenantId: A, userId, permission, effect: "DENY" } });

  it("customers, products and suppliers are hidden without customers.view / products.view / suppliers.view", async () => {
    await prismaBase.customer.create({ data: { tenantId: A, fullName: "Zoubida Quickfind" } });
    await prismaBase.product.create({ data: { tenantId: A, name: "Quickfind lampe", sku: "QF-1", price: 10, status: "ACTIF" } });
    await prismaBase.supplier.create({ data: { tenantId: A, name: "Quickfind Fournisseur" } });

    // Suppliers are a « purchasing » capability: ONLINE_ONLY (the default) hides them.
    await loginAsTestUser({ role: "MANAGER" });
    expect(await hitsOf("quickfind", "supplier")).toEqual([]);

    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const manager = await loginAsTestUser({ role: "MANAGER" });
    expect(await hitsOf("quickfind", "customer")).toHaveLength(1);
    expect(await hitsOf("quickfind", "product")).toHaveLength(1);
    expect(await hitsOf("quickfind", "supplier")).toHaveLength(1);

    await deny(manager.id, "customers.view");
    expect(await hitsOf("quickfind", "customer")).toEqual([]);
    expect(await hitsOf("quickfind", "product")).toHaveLength(1);

    await deny(manager.id, "products.view");
    expect(await hitsOf("quickfind", "product")).toEqual([]);

    await deny(manager.id, "suppliers.view");
    expect(await hitsOf("quickfind", "supplier")).toEqual([]);
  });

  it("an Offline-only user is never offered /finance (ONLINE domain), an Online user is", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "MANAGER" }); // default Online channel
    expect(await pageTitles("finance")).toContain("Finance");

    const store = await prismaBase.salesChannel.create({ data: { tenantId: A, name: "Magasin", kind: "OFFLINE" } });
    const seller = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(seller.id, store.id);
    expect(await pageTitles("finance")).not.toContain("Finance");
    expect((await quickSearchAction("finance")).map((r) => r.href)).not.toContain("/finance");
  });
});
