import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  listTrackingRows,
  getTrackingStats,
  listTrackingCities,
  listTrackingProviders,
  getTrackingDetail,
} from "@/lib/queries/tracking";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

async function provider(name: string, opts: { type?: "API" | "MANUEL"; returnCost?: number; failureCost?: number } = {}) {
  return prisma.shippingProvider.create({
    data: {
      name,
      type: opts.type ?? "API",
      providerKey: opts.type === "MANUEL" ? null : "ozonexpress",
      returnCost: opts.returnCost ?? null,
      failureCost: opts.failureCost ?? null,
    },
  });
}

async function shipment(opts: {
  providerId: string;
  status?: "EN_ATTENTE" | "EN_TRANSIT" | "LIVRE" | "ECHEC" | "RETOURNE" | "ANNULE";
  externalId?: string | null;
  providerStatusRaw?: string | null;
  cost?: number | null;
  costSource?: "CARRIER_API" | "RETURN_RULE" | "FAILURE_RULE" | "MANUAL_OVERRIDE" | null;
  city?: string;
  customerName?: string;
  trackingNumber?: string;
}) {
  const customer = await prisma.customer.create({ data: { fullName: opts.customerName ?? "Client Test" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      status: "EN_PREPARATION",
      subtotal: 200,
      total: 200,
      shippingName: opts.customerName ?? "Client Test",
      shippingCity: opts.city ?? "Casablanca",
      shippingPhone: "0600000000",
    },
  });
  return prisma.shipment.create({
    data: {
      orderId: order.id,
      providerId: opts.providerId,
      status: opts.status ?? "EN_TRANSIT",
      externalId: opts.externalId === undefined ? "ext-" + Math.random().toString(36).slice(2) : opts.externalId,
      providerStatusRaw: opts.providerStatusRaw ?? null,
      cost: opts.cost ?? null,
      costSource: opts.costSource ?? null,
      trackingNumber: opts.trackingNumber ?? null,
    },
  });
}

describe("tracking queries (« Suivi » module, docs/adr/0033)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("lists shipments newest-first with a normalized status", async () => {
    const p = await provider("OzonExpress");
    await shipment({ providerId: p.id, status: "EN_TRANSIT", providerStatusRaw: "Out for delivery" });
    await shipment({ providerId: p.id, status: "LIVRE" });

    const { rows, total } = await listTrackingRows({}, { includeCosts: true });
    expect(total).toBe(2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.normalizedStatus)).toContain("DELIVERED");
    expect(rows.map((r) => r.normalizedStatus)).toContain("OUT_FOR_DELIVERY");
  });

  it("excludes failed API-creation attempts (ECHEC + no externalId + API provider)", async () => {
    const api = await provider("OzonExpress");
    const manual = await provider("Manuel", { type: "MANUEL" });
    await shipment({ providerId: api.id, status: "ECHEC", externalId: null }); // noise
    await shipment({ providerId: manual.id, status: "ECHEC", externalId: null }); // real deliberate failure

    const { rows } = await listTrackingRows({}, { includeCosts: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].providerName).toBe("Manuel");

    const stats = await getTrackingStats();
    expect(stats.total).toBe(1);
  });

  it("filters by normalized status, provider, city and search", async () => {
    const p1 = await provider("OzonExpress");
    const p2 = await provider("Aramex");
    await shipment({ providerId: p1.id, status: "LIVRE", city: "Fès", customerName: "Sara Alaoui" });
    await shipment({ providerId: p2.id, status: "EN_TRANSIT", city: "Rabat", customerName: "Karim Idrissi", trackingNumber: "ABC123" });

    expect((await listTrackingRows({ status: "DELIVERED" }, { includeCosts: true })).rows).toHaveLength(1);
    expect((await listTrackingRows({ providerId: p2.id }, { includeCosts: true })).rows[0].providerName).toBe("Aramex");
    expect((await listTrackingRows({ city: "Fès" }, { includeCosts: true })).rows).toHaveLength(1);
    expect((await listTrackingRows({ q: "sara" }, { includeCosts: true })).rows).toHaveLength(1);
    expect((await listTrackingRows({ q: "ABC123" }, { includeCosts: true })).rows).toHaveLength(1);
  });

  it("hides all cost fields when includeCosts is false", async () => {
    const p = await provider("OzonExpress", { returnCost: 15 });
    await shipment({ providerId: p.id, status: "LIVRE", cost: 30, costSource: "CARRIER_API" });

    const visible = (await listTrackingRows({}, { includeCosts: true })).rows[0];
    expect(visible.deliveryCost).toBe("30");
    expect(visible.costSource).toBe("CARRIER_API");

    const hidden = (await listTrackingRows({}, { includeCosts: false })).rows[0];
    expect(hidden.deliveryCost).toBeNull();
    expect(hidden.returnCost).toBeNull();
    expect(hidden.failureCost).toBeNull();
    expect(hidden.costSource).toBeNull();
  });

  // Client feedback #7: the tracking list must carry the order amount as
  // its own value, never conflated with a delivery / return / failure fee.
  it("exposes the order amount separately from the delivery cost", async () => {
    const p = await provider("OzonExpress");
    await shipment({ providerId: p.id, status: "LIVRE", cost: 30, costSource: "CARRIER_API" });

    const row = (await listTrackingRows({}, { includeCosts: true })).rows[0];
    expect(row.orderTotal).toBe("200"); // the seeded order total
    expect(row.deliveryCost).toBe("30");
    expect(row.orderTotal).not.toBe(row.deliveryCost);
  });

  it("still exposes the order amount when the viewer cannot see costs", async () => {
    const p = await provider("OzonExpress");
    await shipment({ providerId: p.id, status: "LIVRE", cost: 30, costSource: "CARRIER_API" });

    const row = (await listTrackingRows({}, { includeCosts: false })).rows[0];
    expect(row.orderTotal).toBe("200");
    expect(row.deliveryCost).toBeNull();
  });

  it("shows a returned shipment's cost in the return column, from its recorded value", async () => {
    const p = await provider("OzonExpress", { returnCost: 12 });
    await shipment({ providerId: p.id, status: "RETOURNE", cost: 12, costSource: "RETURN_RULE" });

    const row = (await listTrackingRows({}, { includeCosts: true })).rows[0];
    expect(row.deliveryCost).toBeNull();
    expect(row.returnCost).toBe("12");
    expect(row.normalizedStatus).toBe("RETURNED");
  });

  it("getTrackingStats buckets by normalized status", async () => {
    const p = await provider("OzonExpress");
    await shipment({ providerId: p.id, status: "LIVRE" });
    await shipment({ providerId: p.id, status: "LIVRE" });
    await shipment({ providerId: p.id, status: "EN_TRANSIT", providerStatusRaw: "au dépôt" });

    const stats = await getTrackingStats();
    expect(stats.byNormalized.DELIVERED).toBe(2);
    expect(stats.byNormalized.AT_DEPOT).toBe(1);
  });

  it("listTrackingCities / listTrackingProviders return only entities with a shipment", async () => {
    const p1 = await provider("OzonExpress");
    await provider("Aramex (unused)");
    await shipment({ providerId: p1.id, city: "Tanger" });

    expect(await listTrackingCities()).toEqual(["Tanger"]);
    expect((await listTrackingProviders()).map((x) => x.name)).toEqual(["OzonExpress"]);
  });

  it("getTrackingDetail returns the row plus events + address, and flags carrier tracking support", async () => {
    const p = await provider("OzonExpress");
    const s = await shipment({ providerId: p.id, status: "EN_TRANSIT" });

    const detail = await getTrackingDetail(s.id, { includeCosts: true });
    expect(detail).not.toBeNull();
    expect(detail!.shipmentId).toBe(s.id);
    expect(detail!.events).toEqual([]);
    expect(detail!.providerSupportsTracking).toBe(true); // ozonexpress declares FETCH_TRACKING

    expect(await getTrackingDetail("does-not-exist", { includeCosts: true })).toBeNull();
  });
});
