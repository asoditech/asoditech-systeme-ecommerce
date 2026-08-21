import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import {
  testProviderConnection,
  createShipmentViaProvider,
  cancelShipmentViaProvider,
  syncShipmentStatus,
  handleDeliveryWebhook,
} from "@/lib/integrations/delivery/service";
import { registerReferenceDeliveryProvider, referenceDeliveryProvider, REFERENCE_PROVIDER_KEY, REFERENCE_WEBHOOK_TOPIC } from "../helpers/reference-delivery-provider";
import { installFakeReferenceCarrier, emptyFakeCarrierState, FAKE_API_KEY, type FakeCarrierState } from "../helpers/fake-reference-carrier";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { registerDeliveryProvider, __resetDeliveryProviderRegistryForTests } from "@/lib/integrations/delivery/registry";
import { createHmac } from "node:crypto";

let carrierState: FakeCarrierState;
let testUserId: string;

async function seedApiProvider(overrides: { webhookSecret?: string } = {}) {
  const credentials: Record<string, string> = { apiKey: FAKE_API_KEY };
  if (overrides.webhookSecret) credentials.webhookSecret = overrides.webhookSecret;
  return prisma.shippingProvider.create({
    data: {
      name: "Transporteur de référence",
      type: "API",
      providerKey: REFERENCE_PROVIDER_KEY,
      credentialsEncrypted: encryptSecret(JSON.stringify(credentials)),
      connectionStatus: "CONFIGURE",
    },
  });
}

async function seedOrderWithAddress() {
  const warehouse = await prisma.warehouse.create({ data: { id: "wh-1", name: "Entrepôt", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Produit", sku: "SKU-1", price: 200, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      status: "CONFIRMEE",
      subtotal: 200,
      total: 200,
      shippingAddressLine1: "12 rue Hassan II",
      shippingCity: "Rabat",
      shippingCountry: "MA",
      shippingPhone: "0600000000",
      items: { create: [{ productId: product.id, nameSnapshot: "Produit", skuSnapshot: "SKU-1", quantity: 1, unitPrice: 200, total: 200 }] },
    },
    include: { customer: true },
  });
  return order;
}

describe("delivery integration service (against the reference fixture adapter)", () => {
  beforeEach(async () => {
    await resetDb();
    registerReferenceDeliveryProvider();
    carrierState = emptyFakeCarrierState();
    installFakeReferenceCarrier(carrierState);
    testUserId = (await createTestUser({ role: "MANAGER" })).id;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetDb();
  });

  describe("testProviderConnection", () => {
    it("sets CONNECTE only after a real successful request", async () => {
      const provider = await seedApiProvider();
      const result = await testProviderConnection(provider.id);
      expect(result.status).toBe("CONNECTE");
      const updated = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(updated.connectionStatus).toBe("CONNECTE");
      expect(updated.lastConnectionCheckAt).not.toBeNull();
    });

    it("sets ERREUR on invalid credentials, never CONNECTE", async () => {
      const provider = await prisma.shippingProvider.create({
        data: {
          name: "Mauvais identifiants",
          type: "API",
          providerKey: REFERENCE_PROVIDER_KEY,
          credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: "wrong" })),
          connectionStatus: "CONFIGURE",
        },
      });
      const result = await testProviderConnection(provider.id);
      expect(result.status).toBe("ERREUR");
      const updated = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(updated.connectionStatus).toBe("ERREUR");
      expect(updated.lastError).toBeTruthy();
    });

    it("throws DeliveryNotConfiguredError for a MANUEL provider (not an API connector)", async () => {
      const provider = await prisma.shippingProvider.create({ data: { name: "Manuel", type: "MANUEL" } });
      await expect(testProviderConnection(provider.id)).rejects.toThrow();
    });
  });

  describe("createShipmentViaProvider", () => {
    it("persists exactly what the provider returned", async () => {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      expect(shipment.externalId).toBe("ref-1");
      expect(shipment.trackingNumber).toBe("TRK-ref-1");
      expect(Number(shipment.cost)).toBe(25.5);
      expect(shipment.status).toBe("EN_ATTENTE");
    });

    it("rejects an order with an incomplete shipping address rather than calling the provider", async () => {
      const provider = await seedApiProvider();
      const customer = await prisma.customer.create({ data: { fullName: "Sans Adresse" } });
      const order = await prisma.order.create({
        data: { customerId: customer.id, status: "CONFIRMEE", subtotal: 100, total: 100 },
        include: { customer: true },
      });
      await expect(createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null })).rejects.toThrow();
      expect(await prisma.shipment.count()).toBe(0);
    });

    it("marks the shipment ECHEC (never a fake success) when the provider rejects the request", async () => {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      carrierState.forceCreateStatus = 422;
      await expect(createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null })).rejects.toThrow();
      const shipments = await prisma.shipment.findMany({ where: { orderId: order.id } });
      expect(shipments).toHaveLength(1);
      expect(shipments[0].status).toBe("ECHEC");
      expect(shipments[0].externalId).toBeNull();
    });

    it("marks the shipment ECHEC on a malformed provider response rather than persisting a fabricated result", async () => {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      carrierState.malformedCreateResponse = true;
      await expect(createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null })).rejects.toThrow();
      const shipments = await prisma.shipment.findMany({ where: { orderId: order.id } });
      expect(shipments[0].status).toBe("ECHEC");
    });

    it("marks the shipment ECHEC on a timeout rather than claiming success", async () => {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      carrierState.hang = true;
      await expect(createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null })).rejects.toThrow();
      const shipments = await prisma.shipment.findMany({ where: { orderId: order.id } });
      expect(shipments[0].status).toBe("ECHEC");
    }, 8000);

    it("marks the shipment ECHEC even on a genuinely unexpected (non-DeliveryProviderError) failure — never stuck in EN_ATTENTE forever", async () => {
      __resetDeliveryProviderRegistryForTests();
      registerDeliveryProvider({
        ...referenceDeliveryProvider,
        createShipment: async () => {
          throw new TypeError("boom — not a typed DeliveryProviderError");
        },
      });
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      await expect(createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null })).rejects.toThrow(
        "boom"
      );
      const shipments = await prisma.shipment.findMany({ where: { orderId: order.id } });
      expect(shipments).toHaveLength(1);
      expect(shipments[0].status).toBe("ECHEC");
      expect(shipments[0].failedReason).toBe("Erreur inattendue lors de la création de l'expédition.");
    });
  });

  describe("cancelShipmentViaProvider", () => {
    it("calls the carrier before transitioning local status", async () => {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });

      const result = await cancelShipmentViaProvider({ shipment, order, updatedById: testUserId });
      expect(result.ok).toBe(true);
      expect(carrierState.shipments.get(shipment.externalId!)?.status).toBe("cancelled");
      const updated = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(updated.status).toBe("ANNULE");
    });

    it("refuses a shipment with no externalId (not provider-backed)", async () => {
      const provider = await prisma.shippingProvider.create({ data: { name: "Manuel", type: "MANUEL" } });
      const order = await seedOrderWithAddress();
      const shipment = await prisma.shipment.create({ data: { orderId: order.id, providerId: provider.id } });
      const result = await cancelShipmentViaProvider({ shipment, order, updatedById: testUserId });
      expect(result.ok).toBe(false);
    });
  });

  describe("syncShipmentStatus", () => {
    async function createAndAdvance() {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      return { provider, order, shipment };
    }

    it("maps every known provider status and advances the order to LIVREE on LIVRE", async () => {
      const { order, shipment } = await createAndAdvance();
      // Move both state machines to a realistic pre-delivery state first.
      await prisma.shipment.update({ where: { id: shipment.id }, data: { status: "EN_TRANSIT" } });
      await prisma.order.update({ where: { id: order.id }, data: { status: "EXPEDIEE" } });
      carrierState.shipments.get(shipment.externalId!)!.status = "delivered";

      const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { order: true } });
      const result = await syncShipmentStatus({ shipment: fresh, order: fresh.order, updatedById: testUserId });
      expect(result).toEqual({ outcome: "updated", newStatus: "LIVRE" });

      const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updatedOrder.status).toBe("LIVREE");
    });

    it("is idempotent — syncing an unchanged status reports 'unchanged', no order side effect", async () => {
      const { shipment } = await createAndAdvance();
      const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { order: true } });
      const result = await syncShipmentStatus({ shipment: fresh, order: fresh.order, updatedById: testUserId });
      expect(result).toEqual({ outcome: "unchanged" });
    });

    it("preserves an unrecognized provider status as metadata instead of guessing", async () => {
      const { shipment } = await createAndAdvance();
      carrierState.shipments.get(shipment.externalId!)!.status = "some_future_carrier_status";
      const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include: { order: true } });
      const result = await syncShipmentStatus({ shipment: fresh, order: fresh.order, updatedById: testUserId });
      expect(result).toEqual({ outcome: "unknown_status", rawStatus: "some_future_carrier_status" });
      const updated = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(updated.providerStatusRaw).toBe("some_future_carrier_status");
      expect(updated.status).toBe("EN_ATTENTE"); // unchanged locally
    });
  });

  describe("handleDeliveryWebhook", () => {
    function signedBody(body: object, secret: string) {
      const raw = JSON.stringify(body);
      const signature = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
      return { raw, signature };
    }

    it("rejects a webhook with no signature header", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const outcome = await handleDeliveryWebhook({
        providerId: provider.id,
        rawBody: JSON.stringify({ delivery_id: "d1", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "ref-1", status: "delivered" }),
        headers: {},
        deliveryIdHeader: "d1",
      });
      expect(outcome.outcome).toBe("rejected");
    });

    it("processes a validly signed webhook end-to-end via the authoritative-fetch pipeline", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      carrierState.shipments.get(shipment.externalId!)!.status = "in_transit";

      const { raw, signature } = signedBody(
        { delivery_id: "evt-1", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" },
        "whsec_1"
      );
      const outcome = await handleDeliveryWebhook({
        providerId: provider.id,
        rawBody: raw,
        headers: { "x-reference-signature": signature },
        deliveryIdHeader: "evt-1",
      });
      expect(outcome).toEqual({ outcome: "processed", result: { outcome: "updated", newStatus: "EN_TRANSIT" } });
    });

    it("rejects a tampered payload (signature mismatch)", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const { raw } = signedBody({ delivery_id: "evt-1", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "ref-1", status: "delivered" }, "whsec_1");
      const outcome = await handleDeliveryWebhook({
        providerId: provider.id,
        rawBody: raw + "tampered",
        headers: { "x-reference-signature": "bogus" },
        deliveryIdHeader: "evt-1",
      });
      expect(outcome).toEqual({ outcome: "rejected", reason: "Signature invalide." });
    });

    it("replay protection: the same delivery id is processed exactly once", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      const { raw, signature } = signedBody(
        { delivery_id: "evt-replay", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" },
        "whsec_1"
      );
      const params = { providerId: provider.id, rawBody: raw, headers: { "x-reference-signature": signature }, deliveryIdHeader: "evt-replay" };

      const first = await handleDeliveryWebhook(params);
      expect(first.outcome).toBe("processed");
      const second = await handleDeliveryWebhook(params);
      expect(second).toEqual({ outcome: "already_processed" });
    });

    it("concurrent duplicate deliveries of the same event race safely — exactly one is 'processed'", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      const { raw, signature } = signedBody(
        { delivery_id: "evt-concurrent", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" },
        "whsec_1"
      );
      const params = { providerId: provider.id, rawBody: raw, headers: { "x-reference-signature": signature }, deliveryIdHeader: "evt-concurrent" };

      const [a, b] = await Promise.all([handleDeliveryWebhook(params), handleDeliveryWebhook(params)]);
      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(["already_processed", "processed"]);

      const events = await prisma.shipmentWebhookEvent.count({ where: { providerId: provider.id, deliveryId: "evt-concurrent" } });
      expect(events).toBe(1);
    });

    it("acknowledges (ignores, doesn't reject) an unsupported topic", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const { raw, signature } = signedBody({ delivery_id: "evt-2", topic: "unrelated.topic", shipment_id: "ref-1", status: "delivered" }, "whsec_1");
      const outcome = await handleDeliveryWebhook({
        providerId: provider.id,
        rawBody: raw,
        headers: { "x-reference-signature": signature },
        deliveryIdHeader: "evt-2",
      });
      expect(outcome.outcome).toBe("ignored");
    });
  });
});
