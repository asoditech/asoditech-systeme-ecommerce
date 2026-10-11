import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { quickSearchAction } from "@/actions/search";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";

/**
 * Command-palette ORDER results (src/actions/search.ts →
 * src/lib/queries/order-quick-search.ts): the number the tenant SEES, its
 * prefix, the external store number and shipment tracking numbers (exact
 * first, past shipments included) — never a hidden global number, a phone
 * or tracking-like text read as an order number, another tenant's order, or
 * anything for a user without orders.view.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant-b-quick-search";

let seq = 900_000;
async function order(
  tenantId: string,
  o: { displayNumber: number | null; orderNumber?: number; externalNumber?: string; placedMinutesAgo?: number; customer?: string }
) {
  const customer = await prismaBase.customer.create({ data: { tenantId, fullName: o.customer ?? "Sara Amrani" } });
  return prismaBase.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      // Explicit, far from the auto sequence, so a test controls collisions.
      orderNumber: o.orderNumber ?? ++seq,
      displayNumber: o.displayNumber,
      externalNumber: o.externalNumber ?? null,
      externalId: o.externalNumber ? `ext-${tenantId}-${o.externalNumber}` : null,
      source: o.externalNumber ? "WOOCOMMERCE" : "INTERNE",
      placedAt: new Date(Date.now() - (o.placedMinutesAgo ?? 0) * 60_000),
    },
  });
}

async function shipment(tenantId: string, orderId: string, trackingNumber: string, status: "EN_TRANSIT" | "RETOURNE" = "EN_TRANSIT") {
  const provider = await prismaBase.shippingProvider.create({ data: { tenantId, name: `Prov ${trackingNumber}` } });
  return prismaBase.shipment.create({ data: { tenantId, orderId, providerId: provider.id, trackingNumber, status } });
}

const orderHits = async (q: string) => (await quickSearchAction(q)).filter((r) => r.type === "order");

beforeEach(async () => {
  await resetDb();
  await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
});
afterEach(async () => {
  await resetDb();
});

describe("command palette — orders", () => {
  it("CMD-000140 finds the order DISPLAYED as #140, not the one whose hidden global number is 140", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const shown140 = await order(A, { displayNumber: 140, orderNumber: 950_001 });
    const global140 = await order(A, { displayNumber: 7, orderNumber: 140 });
    for (const q of ["CMD-000140", "cmd 140", "000140", "140"]) {
      const hits = await orderHits(q);
      expect(hits.map((h) => h.id), q).toEqual([shown140.id]);
      expect(hits.map((h) => h.id), q).not.toContain(global140.id);
    }
    expect((await orderHits("CMD-000140"))[0]).toMatchObject({ title: "CMD-000140", href: `/commandes/${shown140.id}` });
  });

  it("a pre-Phase-3 order (no displayNumber) is still found by the number it shows", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const legacy = await order(A, { displayNumber: null, orderNumber: 4321 });
    expect((await orderHits("CMD-004321")).map((h) => h.id)).toEqual([legacy.id]);
  });

  it("honours the tenant's custom prefix (and still reads the original « CMD »)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await prismaBase.businessSettings.create({ data: { tenantId: A, orderNumberPrefix: "BL/26" } });
    const mine = await order(A, { displayNumber: 140 });
    for (const q of ["BL/26-000140", "bl/26 140", "CMD-000140"]) {
      expect((await orderHits(q)).map((h) => h.id), q).toEqual([mine.id]);
    }
    expect((await orderHits("BL/26-000140"))[0].title).toBe("BL/26-000140");
  });

  it("external store number, with or without #", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const wc = await order(A, { displayNumber: 1, externalNumber: "WC-1234" });
    for (const q of ["#WC-1234", "wc-1234"]) expect((await orderHits(q)).map((h) => h.id), q).toEqual([wc.id]);
  });

  it("tracking number: exact first, then partial; past shipments included; the match is shown", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const exact = await order(A, { displayNumber: 1, placedMinutesAgo: 5_000 });
    await shipment(A, exact.id, "OZE-555", "RETOURNE"); // a past, returned shipment
    await shipment(A, exact.id, "NEW-PARCEL");
    const partial = await order(A, { displayNumber: 2, placedMinutesAgo: 1 });
    await shipment(A, partial.id, "OZE-5550");
    const hits = await orderHits("oze-555");
    expect(hits.map((h) => h.id)).toEqual([exact.id, partial.id]);
    expect(hits[0].subtitle).toBe("Sara Amrani · Suivi OZE-555");
    expect(hits[1].subtitle).toBe("Sara Amrani · Suivi OZE-5550");
  });

  it("phones and digit-bearing text never become a false order-number match", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    // Orders whose visible numbers equal the digits buried in the queries below.
    await order(A, { displayNumber: 612345678 });
    await order(A, { displayNumber: 123456 });
    await order(A, { displayNumber: 12 });
    for (const q of ["0612345678", "+212 612 34 56 78", "OZ123456", "Article 12"]) {
      expect(await orderHits(q), q).toEqual([]);
    }
  });

  it("out-of-range / huge numeric input never throws", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    for (const q of ["2147483648", "99999999999", "9".repeat(300), "CMD-99999999999"]) {
      await expect(quickSearchAction(q), q).resolves.toBeTruthy();
    }
  });

  it("exact stages treat « % », « _ » and « \\ » literally, and nothing throws", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const o = await order(A, { displayNumber: 1, externalNumber: "WC-1" });
    await shipment(A, o.id, "OZX1");
    // Under 4 characters only the EXACT stages run: no wildcard match.
    for (const q of ["%%", "__", "#%", "%\\"]) expect(await orderHits(q), q).toEqual([]);
    for (const q of ["%%%%", "____", "OZ_1", "OZ\\", "%_\\"]) {
      await expect(quickSearchAction(q), q).resolves.toBeTruthy();
    }
  });

  it("another tenant's order / tracking number is never returned", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const mine = await order(A, { displayNumber: 140 });
    const theirs = await order(B, { displayNumber: 140, externalNumber: "WC-9" });
    await shipment(B, theirs.id, "B-TRACK-1");
    expect((await orderHits("CMD-000140")).map((h) => h.id)).toEqual([mine.id]);
    expect(await orderHits("B-TRACK-1")).toEqual([]);
    expect(await orderHits("#WC-9")).toEqual([]);
  });

  it("at most 5 orders", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    for (let i = 0; i < 7; i++) {
      const o = await order(A, { displayNumber: 10 + i });
      await shipment(A, o.id, `LIM-${i}`);
    }
    expect(await orderHits("LIM-")).toHaveLength(5);
  });

  it("a user without orders.view gets no order results", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const o = await order(A, { displayNumber: 140 });
    await shipment(A, o.id, "SEEN-1");
    await loginAsTestUser({ role: "STORE_SELLER" });
    expect(await orderHits("CMD-000140")).toEqual([]);
    expect(await orderHits("SEEN-1")).toEqual([]);
  });
});

/** A per-user DENY override — the fixture equivalent of « Permissions » › Refuser. */
async function deny(userId: string, permission: string) {
  await prismaBase.userPermissionOverride.create({ data: { tenantId: A, userId, permission, effect: "DENY" } });
}

const shipmentHits = async (q: string) => (await quickSearchAction(q)).filter((r) => r.type === "shipment");

describe("command palette — shipments (« Expéditions »)", () => {
  it("finds a shipment by tracking number (exact first, then partial from 4 characters), carrier + status, linked to Suivi", async () => {
    const o1 = await order(A, { displayNumber: 1 });
    const exact = await shipment(A, o1.id, "TRK-777");
    const o2 = await order(A, { displayNumber: 2 });
    const partial = await shipment(A, o2.id, "TRK-7770", "RETOURNE");
    const agent = await loginAsTestUser({ role: "DELIVERY" }); // delivery.view
    await deny(agent.id, "orders.view"); // no order rows, so the shipment rows are the only answer

    const hits = await shipmentHits("trk-777");
    expect(hits.map((h) => h.id)).toEqual([exact.id, partial.id]);
    expect(hits[0]).toEqual({
      id: exact.id,
      type: "shipment",
      title: "TRK-777",
      subtitle: "Prov TRK-777 · En transit",
      href: "/livraison/suivi?q=TRK-777",
    });
    expect(hits[1].subtitle).toBe("Prov TRK-7770 · Retourné");
    // Never an amount.
    for (const h of hits) expect(h.subtitle).not.toMatch(/MAD|\d+[.,]\d{2}/);
    // Under 4 characters only the exact stage runs.
    expect(await shipmentHits("TRK")).toEqual([]);
  });

  it("a parcel whose order is already listed is not repeated", async () => {
    const o = await order(A, { displayNumber: 3 });
    await shipment(A, o.id, "DUP-123");
    await loginAsTestUser({ role: "ADMIN" }); // orders.view AND delivery.view
    const all = await quickSearchAction("DUP-123");
    expect(all.filter((r) => r.type === "order").map((r) => r.id)).toEqual([o.id]);
    expect(all.filter((r) => r.type === "shipment")).toEqual([]);
  });

  it("another tenant's shipment is never returned", async () => {
    const theirs = await order(B, { displayNumber: 1 });
    await shipment(B, theirs.id, "B-SHIP-1");
    const agent = await loginAsTestUser({ role: "DELIVERY" });
    await deny(agent.id, "orders.view");
    expect(await shipmentHits("B-SHIP-1")).toEqual([]);
    expect(await shipmentHits("B-SHIP")).toEqual([]);
  });

  it("a user without delivery.view gets no shipment results", async () => {
    const o = await order(A, { displayNumber: 4 });
    await shipment(A, o.id, "HIDDEN-1");
    await loginAsTestUser({ role: "CONFIRMATION" }); // orders.view, no delivery.view
    expect(await shipmentHits("HIDDEN-1")).toEqual([]);
    const agent = await loginAsTestUser({ role: "DELIVERY" });
    await deny(agent.id, "orders.view");
    await deny(agent.id, "delivery.view");
    expect(await shipmentHits("HIDDEN-1")).toEqual([]);
  });
});
