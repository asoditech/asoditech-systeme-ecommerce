import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { getDeliveryStats, listShipments, listSupersededShipments } from "@/lib/queries/delivery";
import { getTrackingStats, listTrackingRows } from "@/lib/queries/tracking";
import { deliveryOutcomeRate } from "@/lib/delivery";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import type { ShipmentStatus, ShippingProviderType } from "@prisma/client";

/**
 * S3 — /livraison shows ONE row per order (its current shipment); replaced
 * attempts (cancelled / failed then re-shipped) are history, behind a toggle,
 * and never counted twice in the KPIs. The delivery rate is a final-outcome
 * rate.
 */
const A = DEFAULT_TENANT_ID;
const B = "tenant-b-shipment-history";
const inTenant = <T,>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, "test:shipment-history", fn);

async function seedOrder(tenantId: string) {
  const customer = await prismaBase.customer.create({ data: { tenantId, fullName: "Client" } });
  return prismaBase.order.create({ data: { tenantId, customerId: customer.id, subtotal: 100, total: 100, status: "EXPEDIEE" } });
}

async function provider(tenantId: string, type: ShippingProviderType = "MANUEL") {
  return prismaBase.shippingProvider.create({ data: { tenantId, name: `P-${type}-${Math.random()}`, type } });
}

async function shipment(
  tenantId: string,
  orderId: string,
  providerId: string,
  status: ShipmentStatus,
  createdAt: string,
  externalId: string | null = null
) {
  return prismaBase.shipment.create({ data: { tenantId, orderId, providerId, status, createdAt: new Date(createdAt), externalId } });
}

beforeEach(resetDb);
afterEach(resetDb);

describe("deliveryOutcomeRate — the one « Taux de livraison réussie »", () => {
  it("delivered ÷ (delivered + failed + returned); nothing finished → null, never a fake 0 %", () => {
    expect(deliveryOutcomeRate({ delivered: 3, failed: 1, returned: 0 })).toBe(0.75);
    expect(deliveryOutcomeRate({ delivered: 1, failed: 1, returned: 2 })).toBe(0.25);
    expect(deliveryOutcomeRate({ delivered: 0, failed: 0, returned: 0 })).toBeNull();
  });
});

describe("shipment history — current row per order", () => {
  it("a cancelled then re-shipped order is one current row (+1 previous attempt); the history view shows both", async () => {
    const order = await seedOrder(A);
    const manual = await provider(A);
    const cancelled = await shipment(A, order.id, manual.id, "ANNULE", "2026-10-01T10:00:00Z");
    const current = await shipment(A, order.id, manual.id, "EN_TRANSIT", "2026-10-02T10:00:00Z");

    const def = await inTenant(A, () => listShipments({}));
    expect(def.shipments.map((s) => s.id)).toEqual([current.id]);
    expect(def.total).toBe(1);
    expect(def.previousAttemptsByOrder[order.id]).toBe(1);

    // A search reaches the old parcel too, labelled as replaced.
    await prismaBase.shipment.update({ where: { id: cancelled.id }, data: { trackingNumber: "OLD-PARCEL-1" } });
    const searched = await inTenant(A, () => listShipments({ search: "OLD-PARCEL-1" }));
    expect(searched.shipments.map((s) => s.id)).toEqual([cancelled.id]);
    expect(searched.supersededIds).toEqual([cancelled.id]);

    const hist = await inTenant(A, () => listShipments({ history: true }));
    expect(hist.shipments.map((s) => s.id).sort()).toEqual([cancelled.id, current.id].sort());
    expect(hist.supersededIds).toEqual([cancelled.id]);
  });

  it("a failed API creation attempt never replaces the real parcel", async () => {
    const order = await seedOrder(A);
    const manual = await provider(A);
    const api = await provider(A, "API");
    const real = await shipment(A, order.id, manual.id, "ECHEC", "2026-10-01T10:00:00Z");
    await shipment(A, order.id, api.id, "ECHEC", "2026-10-02T10:00:00Z", null); // never reached the carrier
    expect(await inTenant(A, listSupersededShipments)).toEqual([]);
    expect((await inTenant(A, () => listShipments({}))).shipments.map((s) => s.id)).toEqual([real.id]);
  });

  it("KPIs count each order once, by its final outcome", async () => {
    const manual = await provider(A);
    // Order 1: failed, then delivered on retry → one delivered order, not « 1 failed + 1 delivered ».
    const o1 = await seedOrder(A);
    await shipment(A, o1.id, manual.id, "ECHEC", "2026-10-01T10:00:00Z");
    await shipment(A, o1.id, manual.id, "LIVRE", "2026-10-03T10:00:00Z");
    // Order 2: returned.
    const o2 = await seedOrder(A);
    await shipment(A, o2.id, manual.id, "RETOURNE", "2026-10-02T10:00:00Z");
    // Order 3: still on its way, order 4: cancelled with no replacement — no outcome.
    const o3 = await seedOrder(A);
    await shipment(A, o3.id, manual.id, "EN_TRANSIT", "2026-10-02T10:00:00Z");
    const o4 = await seedOrder(A);
    await shipment(A, o4.id, manual.id, "ANNULE", "2026-10-02T10:00:00Z");

    const stats = await inTenant(A, () => getDeliveryStats());
    expect(stats).toMatchObject({ total: 4, delivered: 1, failed: 0, returned: 1, inTransit: 1 });
    expect(stats.successRate).toBe(0.5); // 1 ÷ (1 + 0 + 1)
  });

  it("the history query stays in its tenant", async () => {
    await prismaBase.tenant.create({ data: { id: B, name: "B", slug: B } });
    const orderB = await seedOrder(B);
    const pB = await provider(B);
    const oldB = await shipment(B, orderB.id, pB.id, "ANNULE", "2026-10-01T10:00:00Z");
    await shipment(B, orderB.id, pB.id, "EN_ATTENTE", "2026-10-02T10:00:00Z");

    expect(await inTenant(A, listSupersededShipments)).toEqual([]);
    expect((await inTenant(B, listSupersededShipments)).map((s) => s.id)).toEqual([oldB.id]);
    expect((await inTenant(A, () => listShipments({ history: true }))).total).toBe(0);
  });
});

describe("« Suivi » — replaced parcels are history there too", () => {
  it("stats and the default list count a re-shipped order once (same rule as /livraison)", async () => {
    const manual = await provider(A);
    const order = await seedOrder(A);
    const failed = await shipment(A, order.id, manual.id, "ECHEC", "2026-10-01T10:00:00Z");
    const current = await shipment(A, order.id, manual.id, "EN_TRANSIT", "2026-10-02T10:00:00Z");
    await prismaBase.shipment.update({ where: { id: failed.id }, data: { trackingNumber: "OLD-SUIVI-1" } });

    const stats = await inTenant(A, () => getTrackingStats());
    expect(stats.total).toBe(1);
    expect(stats.byNormalized.FAILED).toBe(0);

    const list = await inTenant(A, () => listTrackingRows({}, { includeCosts: false }));
    expect(list.rows.map((r) => r.shipmentId)).toEqual([current.id]);
    expect(list.total).toBe(1);

    // A search still reaches the replaced parcel.
    const searched = await inTenant(A, () => listTrackingRows({ q: "OLD-SUIVI-1" }, { includeCosts: false }));
    expect(searched.rows.map((r) => r.shipmentId)).toEqual([failed.id]);
  });
});
