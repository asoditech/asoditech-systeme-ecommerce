import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { MAX_ORDER_NUMBER, orderNumberFromQuery, orderSearchWhere } from "@/lib/orders/search";
import { listOrders } from "@/lib/queries/orders";
import { listOrdersAwaitingConfirmation } from "@/lib/queries/order-confirmation";
import { listOrdersAwaitingShipment, listShipments } from "@/lib/queries/delivery";
import { listTrackingRows } from "@/lib/queries/tracking";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import type { OrderStatus, RecordSource } from "@prisma/client";

/**
 * P1 — the shared order search (src/lib/orders/search.ts) behind /commandes,
 * the confirmation queue, « À expédier » and /livraison/suivi. Two tenants
 * deliberately share the SAME displayed number (140), tracking-number shape
 * and customer name, so a search can only ever be right by staying in its
 * own tenant.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant-b-order-search";

async function seedOrder(
  tenantId: string,
  o: {
    displayNumber: number;
    status?: OrderStatus;
    trackingNumber?: string;
    externalNumber?: string;
    source?: RecordSource;
    shippingName?: string;
    phone?: string;
    phoneKey?: string;
  }
) {
  const customer = await prismaBase.customer.create({
    data: { tenantId, fullName: "Sara Amrani", phone: o.phone ?? null, phoneKey: o.phoneKey ?? null },
  });
  const order = await prismaBase.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      status: o.status ?? "NOUVELLE",
      displayNumber: o.displayNumber,
      externalNumber: o.externalNumber ?? null,
      externalId: o.externalNumber ? `ext-${o.externalNumber}` : null,
      source: o.source ?? "INTERNE",
      shippingName: o.shippingName ?? null,
    },
  });
  if (o.trackingNumber) {
    const provider = await prismaBase.shippingProvider.create({ data: { tenantId, name: `Ozon ${tenantId}` } });
    await prismaBase.shipment.create({
      data: { tenantId, orderId: order.id, providerId: provider.id, trackingNumber: o.trackingNumber, status: "EN_TRANSIT" },
    });
  }
  return order;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const inA = <T,>(fn: () => Promise<T>) => runWithTenant(A, "test:order-search", fn);

beforeEach(async () => {
  await resetDb();
  await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
});
afterEach(async () => {
  await resetDb();
});

describe("orderNumberFromQuery", () => {
  it("reads bare, zero-padded, configured-prefix and legacy-prefix numbers", () => {
    expect(orderNumberFromQuery("140")).toBe(140);
    expect(orderNumberFromQuery("000140")).toBe(140);
    expect(orderNumberFromQuery("CMD-000140", "CMD")).toBe(140);
    expect(orderNumberFromQuery("cmd 140", "CMD")).toBe(140);
    expect(orderNumberFromQuery("BL/26-000140", "BL/26")).toBe(140);
    expect(orderNumberFromQuery("bl/26000140", "BL/26")).toBe(140);
    expect(orderNumberFromQuery("CMD-000140", "BL/26")).toBe(140); // number shown before a prefix change
    expect(orderNumberFromQuery("  CMD-000140  ")).toBe(140);
  });

  it("never yields a non-integer, zero, negative or oversized number (Int column safe)", () => {
    for (const q of ["12.5", "1e3", "-5", "0", "000", "2147483648", "99999999999", "abc", "", "  ", "#140", "CMD-12.5", "1 2"]) {
      expect(orderNumberFromQuery(q, "CMD"), q).toBeNull();
    }
    expect(orderNumberFromQuery(String(MAX_ORDER_NUMBER))).toBe(MAX_ORDER_NUMBER);
    expect(orderNumberFromQuery("1".repeat(200))).toBeNull();
  });

  it("an empty search adds no condition", () => {
    expect(orderSearchWhere("   ")).toEqual({});
    expect(orderSearchWhere(undefined)).toEqual({});
  });
});

describe("/commandes (listOrders) — shared search, tenant-scoped", () => {
  it("finds the order by its displayed number, with or without the prefix — never the other tenant's #140", async () => {
    const mine = await seedOrder(A, { displayNumber: 140 });
    const theirs = await seedOrder(B, { displayNumber: 140 });
    for (const q of ["CMD-000140", "000140", "140"]) {
      const found = ids((await inA(() => listOrders({ q }))).orders);
      expect(found, q).toContain(mine.id);
      expect(found, q).not.toContain(theirs.id);
    }
  });

  it("honours the tenant's custom prefix", async () => {
    await prismaBase.businessSettings.create({ data: { tenantId: A, orderNumberPrefix: "BL/26" } });
    const mine = await seedOrder(A, { displayNumber: 140 });
    expect(ids((await inA(() => listOrders({ q: "BL/26-000140" }))).orders)).toEqual([mine.id]);
  });

  it("finds by tracking number, external number, recipient name and partial phone — only in its own tenant", async () => {
    const mine = await seedOrder(A, {
      displayNumber: 1,
      trackingNumber: "OZE-777-A",
      externalNumber: "WC-1234",
      source: "WOOCOMMERCE",
      shippingName: "Destinataire Unique",
      phone: "06 11 22 33 44",
      phoneKey: "212611223344",
    });
    const theirs = await seedOrder(B, { displayNumber: 1, trackingNumber: "OZE-777-B", externalNumber: "WC-1234", source: "WOOCOMMERCE" });

    for (const q of ["OZE-777-A", "oze-777-a", "#WC-1234", "WC-1234", "Destinataire Unique", "0611 22", "+212 611 22 33 44"]) {
      const found = ids((await inA(() => listOrders({ q }))).orders);
      expect(found, q).toContain(mine.id);
      expect(found, q).not.toContain(theirs.id);
    }
    // Another tenant's tracking number is invisible here.
    expect(ids((await inA(() => listOrders({ q: "OZE-777-B" }))).orders)).toEqual([]);
  });

  it("non-integer / oversized / very long input never throws", async () => {
    await seedOrder(A, { displayNumber: 3 });
    for (const q of ["12.5", "1e3", "99999999999", "x".repeat(500), "%_\\"]) {
      await expect(inA(() => listOrders({ q })), q).resolves.toBeTruthy();
    }
  });
});

describe("confirmation queue / « À expédier » / Suivi — same search", () => {
  it("confirmation queue: displayed number with prefix, own tenant only", async () => {
    const mine = await seedOrder(A, { displayNumber: 140 });
    const theirs = await seedOrder(B, { displayNumber: 140 });
    const found = ids((await inA(() => listOrdersAwaitingConfirmation({ search: "CMD-000140" }))).orders);
    expect(found).toEqual([mine.id]);
    expect(found).not.toContain(theirs.id);
  });

  it("« À expédier »: displayed number with prefix, own tenant only", async () => {
    const mine = await seedOrder(A, { displayNumber: 140, status: "CONFIRMEE" });
    await seedOrder(B, { displayNumber: 140, status: "CONFIRMEE" });
    expect(ids((await inA(() => listOrdersAwaitingShipment({ search: "CMD-000140" }))).orders)).toEqual([mine.id]);
  });

  it("Suivi: tracking number and custom-prefixed displayed number, own tenant only", async () => {
    await prismaBase.businessSettings.create({ data: { tenantId: A, orderNumberPrefix: "BL/26" } });
    const mine = await seedOrder(A, { displayNumber: 140, status: "EXPEDIEE", trackingNumber: "OZE-555-A" });
    const theirs = await seedOrder(B, { displayNumber: 140, status: "EXPEDIEE", trackingNumber: "OZE-555-B" });
    for (const q of ["BL/26-000140", "OZE-555-A"]) {
      const rows = (await inA(() => listTrackingRows({ q }, { includeCosts: false }))).rows;
      expect(rows.map((r) => r.orderId), q).toEqual([mine.id]);
      expect(rows.map((r) => r.orderId), q).not.toContain(theirs.id);
    }
    expect((await inA(() => listTrackingRows({ q: "OZE-555-B" }, { includeCosts: false }))).rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// « Expéditions & suivi » (listShipments) — now the shared search, plus
// exact-tracking-first ranking on every delivery / order list.
// ---------------------------------------------------------------------------

async function addShipment(
  tenantId: string,
  orderId: string,
  s: {
    trackingNumber?: string | null;
    status?: "EN_ATTENTE" | "EN_TRANSIT" | "LIVRE" | "ECHEC" | "RETOURNE" | "ANNULE";
    providerType?: "MANUEL" | "API";
    externalId?: string | null;
    createdAt?: Date;
  } = {}
) {
  const provider = await prismaBase.shippingProvider.create({
    data: { tenantId, name: `Prov ${tenantId}`, type: s.providerType ?? "MANUEL" },
  });
  return prismaBase.shipment.create({
    data: {
      tenantId,
      orderId,
      providerId: provider.id,
      trackingNumber: s.trackingNumber ?? null,
      status: s.status ?? "EN_TRANSIT",
      externalId: s.externalId ?? null,
      ...(s.createdAt ? { createdAt: s.createdAt } : {}),
    },
  });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("/livraison « Expéditions » (listShipments) — shared search, tenant-scoped", () => {
  it("CMD-000140 / 000140 / custom prefix find the DISPLAYED #140, never the other tenant's", async () => {
    const mine = await seedOrder(A, { displayNumber: 140, status: "EXPEDIEE" });
    const theirs = await seedOrder(B, { displayNumber: 140, status: "EXPEDIEE" });
    const s = await addShipment(A, mine.id, { trackingNumber: "ZZ-1" });
    await addShipment(B, theirs.id, { trackingNumber: "ZZ-2" });
    for (const q of ["CMD-000140", "000140", "140", "cmd 140"]) {
      expect(ids((await inA(() => listShipments({ search: q }))).shipments), q).toEqual([s.id]);
    }
    await prismaBase.businessSettings.create({ data: { tenantId: A, orderNumberPrefix: "BL/26" } });
    expect(ids((await inA(() => listShipments({ search: "BL/26-000140" }))).shipments)).toEqual([s.id]);
    // The caller-supplied prefix is used as-is (no second settings read needed).
    expect(ids((await inA(() => listShipments({ search: "XY-000140", orderNumberPrefix: "XY" }))).shipments)).toEqual([s.id]);
  });

  it("external store number (with / without #), recipient + formatted phone, customer name", async () => {
    const mine = await seedOrder(A, {
      displayNumber: 2,
      status: "EXPEDIEE",
      externalNumber: "1234",
      source: "WOOCOMMERCE",
      shippingName: "Destinataire Unique",
      phone: "06 11 22 33 44",
      phoneKey: "212611223344",
    });
    await prismaBase.order.update({ where: { id: mine.id }, data: { shippingPhone: "0699 88 77 66" } });
    const s = await addShipment(A, mine.id, { trackingNumber: "ZZ-3" });
    for (const q of ["#1234", "1234", "Destinataire Unique", "0699 88", "Sara Amrani", "0611 22", "+212 611 22 33 44"]) {
      expect(ids((await inA(() => listShipments({ search: q }))).shipments), q).toContain(s.id);
    }
  });

  it("tracking number: exact, partial, any case — another tenant's is invisible", async () => {
    const mine = await seedOrder(A, { displayNumber: 3, status: "EXPEDIEE" });
    const theirs = await seedOrder(B, { displayNumber: 3, status: "EXPEDIEE" });
    const s = await addShipment(A, mine.id, { trackingNumber: "OZE-900-A" });
    await addShipment(B, theirs.id, { trackingNumber: "OZE-900-B" });
    for (const q of ["OZE-900-A", "oze-900-a", "900-A", "OZE-900"]) {
      expect(ids((await inA(() => listShipments({ search: q }))).shipments), q).toEqual([s.id]);
    }
    expect((await inA(() => listShipments({ search: "OZE-900-B" }))).shipments).toEqual([]);
  });

  it("long numeric / out-of-Int-range input never throws", async () => {
    const mine = await seedOrder(A, { displayNumber: 4, status: "EXPEDIEE" });
    const s = await addShipment(A, mine.id, { trackingNumber: "12345678901234" });
    for (const q of ["2147483648", "99999999999", "1".repeat(300), "12.5", "%_\\"]) {
      await expect(inA(() => listShipments({ search: q })), q).resolves.toBeTruthy();
    }
    // A long all-digit tracking number is found (it used to crash the Int filter).
    expect(ids((await inA(() => listShipments({ search: "12345678901234" }))).shipments)).toEqual([s.id]);
  });

  it("a failed API creation attempt stays hidden; a MANUEL failure and a past shipment stay searchable", async () => {
    const order = await seedOrder(A, { displayNumber: 5, status: "EXPEDIEE" });
    await addShipment(A, order.id, { trackingNumber: "FAIL-API", status: "ECHEC", providerType: "API", externalId: null });
    const manualFail = await addShipment(A, order.id, { trackingNumber: "FAIL-MAN", status: "ECHEC" });
    const old = await addShipment(A, order.id, { trackingNumber: "HIST-OLD", status: "RETOURNE", createdAt: minutesAgo(60) });
    await addShipment(A, order.id, { trackingNumber: "HIST-NEW", status: "EN_TRANSIT" });
    expect((await inA(() => listShipments({ search: "FAIL-API" }))).shipments).toEqual([]);
    expect(ids((await inA(() => listShipments({ search: "FAIL-MAN" }))).shipments)).toEqual([manualFail.id]);
    expect(ids((await inA(() => listShipments({ search: "HIST-OLD" }))).shipments)).toEqual([old.id]);
  });
});

describe("exact tracking number first — across pages, newest first inside each group", () => {
  it("listShipments: the exact match tops page 1 even when 31 newer partial matches exist", async () => {
    const order = await seedOrder(A, { displayNumber: 6, status: "EXPEDIEE" });
    const exact = await addShipment(A, order.id, { trackingNumber: "OZX-1", createdAt: minutesAgo(500) });
    const partial: string[] = [];
    for (let i = 0; i < 31; i++) {
      partial.push((await addShipment(A, order.id, { trackingNumber: `OZX-1-${i}`, createdAt: minutesAgo(100 - i) })).id);
    }
    const page1 = await inA(() => listShipments({ search: "ozx-1", page: 1 }));
    const page2 = await inA(() => listShipments({ search: "ozx-1", page: 2 }));
    expect(page1.total).toBe(32);
    expect(page1.shipments[0].id).toBe(exact.id);
    const all = [...ids(page1.shipments), ...ids(page2.shipments)];
    expect(all).toHaveLength(32);
    expect(new Set(all).size).toBe(32);
    // Partial matches keep the existing newest-first order.
    expect(all.slice(1)).toEqual([...partial].reverse());
  });

  it("rows WITHOUT a tracking number are not lost when an exact match is ranked first", async () => {
    const order = await seedOrder(A, { displayNumber: 7, status: "EXPEDIEE", shippingName: "QQ-77" });
    const exact = await addShipment(A, order.id, { trackingNumber: "QQ-77" });
    const noTracking = await addShipment(A, order.id, { trackingNumber: null, createdAt: minutesAgo(5) });
    const found = await inA(() => listShipments({ search: "QQ-77" }));
    expect(found.total).toBe(2);
    expect(ids(found.shipments)).toEqual([exact.id, noTracking.id]);
  });

  it("Suivi: exact match first, then the partial ones newest first", async () => {
    const order = await seedOrder(A, { displayNumber: 8, status: "EXPEDIEE" });
    const exact = await addShipment(A, order.id, { trackingNumber: "SV-1", createdAt: minutesAgo(90) });
    const p1 = await addShipment(A, order.id, { trackingNumber: "SV-10", createdAt: minutesAgo(10) });
    const p2 = await addShipment(A, order.id, { trackingNumber: "SV-11", createdAt: minutesAgo(5) });
    const rows = (await inA(() => listTrackingRows({ q: "sv-1" }, { includeCosts: false }))).rows;
    expect(rows.map((r) => r.shipmentId)).toEqual([exact.id, p2.id, p1.id]);
  });

  it("/commandes: the order with the exact tracking number (even on a PAST shipment) tops page 1", async () => {
    const target = await seedOrder(A, { displayNumber: 9, status: "EXPEDIEE" });
    await prismaBase.order.update({ where: { id: target.id }, data: { placedAt: minutesAgo(10_000) } });
    await addShipment(A, target.id, { trackingNumber: "CM-5", status: "RETOURNE", createdAt: minutesAgo(9_000) });
    await addShipment(A, target.id, { trackingNumber: "NEW-PARCEL", status: "EN_TRANSIT" });
    for (let i = 0; i < 26; i++) {
      const o = await seedOrder(A, { displayNumber: 100 + i, status: "EXPEDIEE" });
      await addShipment(A, o.id, { trackingNumber: `CM-5-${i}` });
    }
    const page1 = await inA(() => listOrders({ q: "CM-5", page: 1 }));
    const page2 = await inA(() => listOrders({ q: "CM-5", page: 2 }));
    expect(page1.total).toBe(27);
    expect(page1.orders[0].id).toBe(target.id);
    const all = [...ids(page1.orders), ...ids(page2.orders)];
    expect(new Set(all).size).toBe(27);
  });

  it("« À expédier »: exact match on a failed attempt's tracking number ranks first", async () => {
    const exact = await seedOrder(A, { displayNumber: 10, status: "CONFIRMEE" });
    await prismaBase.order.update({ where: { id: exact.id }, data: { placedAt: minutesAgo(1_000) } });
    await addShipment(A, exact.id, { trackingNumber: "AX-2", status: "ANNULE" });
    const partial = await seedOrder(A, { displayNumber: 11, status: "CONFIRMEE" });
    await addShipment(A, partial.id, { trackingNumber: "AX-20", status: "ANNULE" });
    expect(ids((await inA(() => listOrdersAwaitingShipment({ search: "ax-2" }))).orders)).toEqual([exact.id, partial.id]);
  });
});

describe("exact ranking never treats « % » / « _ » / « \\ » as patterns", () => {
  it("only the LITERAL exact number is ranked first, and nothing throws", async () => {
    const order = await seedOrder(A, { displayNumber: 12, status: "EXPEDIEE" });
    const literal = await addShipment(A, order.id, { trackingNumber: "OZ_1", createdAt: minutesAgo(60) });
    const lookalike = await addShipment(A, order.id, { trackingNumber: "OZX1" });
    // (The partial `contains` search may still list « OZX1 »: Prisma does not
    // escape « _ » / « % » in `contains` — pre-existing, app-wide behaviour.)
    const found = ids((await inA(() => listShipments({ search: "oz_1" }))).shipments);
    expect(found[0]).toBe(literal.id);
    // « % » never makes every row an "exact" match: the newest row stays first.
    const pct = ids((await inA(() => listShipments({ search: "%" }))).shipments);
    expect(pct[0]).toBe(lookalike.id);
    for (const q of ["%", "_", "\\", "OZ\\", "%_\\"]) {
      await expect(inA(() => listShipments({ search: q })), q).resolves.toBeTruthy();
      await expect(inA(() => listTrackingRows({ q }, { includeCosts: false })), q).resolves.toBeTruthy();
      await expect(inA(() => listOrders({ q })), q).resolves.toBeTruthy();
      await expect(inA(() => listOrdersAwaitingShipment({ search: q })), q).resolves.toBeTruthy();
    }
  });
});
