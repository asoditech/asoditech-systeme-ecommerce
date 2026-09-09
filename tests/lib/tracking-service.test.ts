import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { refreshShipmentTracking } from "@/lib/integrations/delivery/tracking-service";
import {
  registerReferenceDeliveryProvider,
  REFERENCE_PROVIDER_KEY,
} from "../helpers/reference-delivery-provider";
import {
  installFakeReferenceCarrier,
  emptyFakeCarrierState,
  FAKE_API_KEY,
  type FakeCarrierState,
} from "../helpers/fake-reference-carrier";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

let carrierState: FakeCarrierState;
let userId: string;

async function seedShipment(status: "EN_ATTENTE" | "EN_TRANSIT" = "EN_TRANSIT") {
  const provider = await prisma.shippingProvider.create({
    data: {
      name: "Transporteur de référence",
      type: "API",
      providerKey: REFERENCE_PROVIDER_KEY,
      credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_API_KEY })),
      connectionStatus: "CONNECTE",
    },
  });
  const customer = await prisma.customer.create({ data: { fullName: "Sara Alaoui" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      status: "EN_PREPARATION",
      subtotal: 300,
      total: 300,
      shippingCity: "Fès",
    },
  });
  // Pre-seed the fake carrier's record so status fetch + tracking resolve.
  const externalId = "ref-track-1";
  carrierState.shipments.set(externalId, {
    id: externalId,
    status: "in_transit",
    tracking_number: "TRK-ref-track-1",
    tracking_url: "https://example.com/track/ref-track-1",
    cost: 25.5,
  });
  const shipment = await prisma.shipment.create({
    data: {
      orderId: order.id,
      providerId: provider.id,
      status,
      externalId,
      trackingNumber: "TRK-ref-track-1",
      providerStatusRaw: "in_transit",
    },
  });
  return { shipment, order };
}

describe("refreshShipmentTracking (« Suivi » module, docs/adr/0033)", () => {
  beforeEach(async () => {
    await resetDb();
    registerReferenceDeliveryProvider();
    carrierState = emptyFakeCarrierState();
    installFakeReferenceCarrier(carrierState);
    userId = (await createTestUser({ role: "MANAGER" })).id;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetDb();
  });

  it("persists normalized carrier events and stamps lastTrackingSyncAt", async () => {
    carrierState.trackingEvents = [
      { status: "created", description: "Colis enregistré", location: "Casablanca", at: "2026-09-01T08:00:00.000Z" },
      { status: "in_transit", description: "En route", location: "Rabat", at: "2026-09-02T09:00:00.000Z" },
    ];
    const { shipment, order } = await seedShipment();

    const outcome = await refreshShipmentTracking({ shipment, order, updatedById: userId });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.eventsFetched).toBe(true);
      expect(outcome.eventCount).toBe(2);
    }

    const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    const events = fresh.trackingEvents as unknown as { rawStatus: string; code: string; location: string | null }[];
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ rawStatus: "in_transit", location: "Rabat" });
    expect(events[0].code).toBeTruthy();
    expect(fresh.lastTrackingSyncAt).not.toBeNull();
    expect(fresh.trackingSyncError).toBeNull();
  });

  it("records the courier only when the carrier actually reports one", async () => {
    const { shipment, order } = await seedShipment();
    await refreshShipmentTracking({ shipment, order, updatedById: userId });
    let fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(fresh.courierName).toBeNull();
    expect(fresh.courierPhone).toBeNull();

    carrierState.trackingCourier = { name: "Youssef", phone: "0655555555" };
    await refreshShipmentTracking({ shipment: fresh, order, updatedById: userId });
    fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(fresh.courierName).toBe("Youssef");
    expect(fresh.courierPhone).toBe("0655555555");
  });

  it("a tracking-call failure keeps the last-known status + events, only setting trackingSyncError", async () => {
    carrierState.trackingEvents = [
      { status: "in_transit", description: "En route", location: "Rabat", at: "2026-09-02T09:00:00.000Z" },
    ];
    const { shipment, order } = await seedShipment();
    await refreshShipmentTracking({ shipment, order, updatedById: userId });
    const afterGood = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect((afterGood.trackingEvents as unknown[]).length).toBe(1);

    // Now the tracking endpoint fails.
    carrierState.forceTrackingStatus = 500;
    const outcome = await refreshShipmentTracking({ shipment: afterGood, order, updatedById: userId });
    // The overall refresh still "succeeds" (status sync worked); tracking is best-effort.
    expect(outcome.ok).toBe(true);

    const afterFail = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect((afterFail.trackingEvents as unknown[]).length).toBe(1); // NOT wiped
    expect(afterFail.status).toBe(afterGood.status); // NOT overwritten
    expect(afterFail.trackingSyncError).toBeTruthy();
    expect(afterFail.lastTrackingSyncAt).not.toBeNull();
  });

  it("refuses a shipment with no externalId (manual provider)", async () => {
    const provider = await prisma.shippingProvider.create({ data: { name: "Manuel", type: "MANUEL" } });
    const customer = await prisma.customer.create({ data: { fullName: "X" } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, status: "EN_PREPARATION", subtotal: 10, total: 10 },
    });
    const shipment = await prisma.shipment.create({
      data: { orderId: order.id, providerId: provider.id, status: "EN_ATTENTE" },
    });
    const outcome = await refreshShipmentTracking({ shipment, order, updatedById: userId });
    expect(outcome.ok).toBe(false);
  });
});
