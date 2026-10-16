import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Counts the WooCommerce « completed » pushes a carrier event triggers (the
// stock push keeps its real implementation).
const autoPush = vi.hoisted(() => ({ pushOrderStatusToWooCommerce: vi.fn(async (orderId: string): Promise<void> => void orderId) }));
vi.mock("@/lib/integrations/shared/auto-push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/shared/auto-push")>()),
  pushOrderStatusToWooCommerce: autoPush.pushOrderStatusToWooCommerce,
}));

import { prisma } from "@/lib/prisma";
import { applyShipmentStatusTransition } from "@/lib/delivery";
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
import { DuplicateActiveShipmentError } from "@/lib/integrations/delivery/service";
import { DeliveryOutcomeUnknownError } from "@/lib/integrations/delivery/errors";
import { isShipmentOutcomeUnknown, SHIPMENT_OUTCOME_UNKNOWN_PREFIX } from "@/lib/validation/delivery";

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
      // the pre-call « à vérifier » marker is replaced by the definite reason
      expect(isShipmentOutcomeUnknown(shipments[0])).toBe(false);
    });

    describe("« à vérifier » is recorded BEFORE the carrier call (process death mid-request)", () => {
      async function snapshotDuringCall(behaviour: "succeed" | "unknown") {
        let duringCall: { status: string; externalId: string | null; failedReason: string | null } | null = null;
        __resetDeliveryProviderRegistryForTests();
        registerDeliveryProvider({
          ...referenceDeliveryProvider,
          createShipment: async (input, credentials, config) => {
            duringCall = await prisma.shipment.findUniqueOrThrow({
              where: { id: input.localShipmentId },
              select: { status: true, externalId: true, failedReason: true },
            });
            if (behaviour === "unknown") throw new DeliveryOutcomeUnknownError("Résultat inconnu (test).");
            return referenceDeliveryProvider.createShipment!(input, credentials, config);
          },
        });
        const provider = await seedApiProvider();
        const order = await seedOrderWithAddress();
        const outcome = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null }).catch(
          (e: unknown) => e
        );
        const after = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
        return { duringCall: duringCall!, outcome, after, provider, order };
      }

      it("while the request is in flight the row is already EN_ATTENTE « à vérifier » — a crash leaves it blocking and explained", async () => {
        const { duringCall, provider, order } = await snapshotDuringCall("succeed");
        expect(isShipmentOutcomeUnknown(duringCall)).toBe(true);
        expect(duringCall.failedReason).toMatch(/vérifiez sur le portail du transporteur/);
        // what a later attempt would face had the process died at that point
        await prisma.shipment.updateMany({ where: { orderId: order.id }, data: { externalId: null, failedReason: duringCall.failedReason } });
        const second = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null }).catch(
          (e: unknown) => e
        );
        expect(second).toBeInstanceOf(DuplicateActiveShipmentError);
        expect((second as Error).message).toMatch(/à vérifier/);
      });

      it("a successful creation clears the marker", async () => {
        const { after, outcome } = await snapshotDuringCall("succeed");
        expect(outcome).not.toBeInstanceOf(Error);
        expect(after.externalId).toBe("ref-1");
        expect(after.failedReason).toBeNull();
        expect(isShipmentOutcomeUnknown(after)).toBe(false);
      });

      it("an unknown outcome replaces it with the adapter's precise message, still EN_ATTENTE", async () => {
        const { after, outcome } = await snapshotDuringCall("unknown");
        expect(outcome).toBeInstanceOf(DeliveryOutcomeUnknownError);
        expect(after.status).toBe("EN_ATTENTE");
        expect(after.failedReason).toBe(`${SHIPMENT_OUTCOME_UNKNOWN_PREFIX}Résultat inconnu (test).`);
      });
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

  describe("delivery cost rules (ADR 0032)", () => {
    async function shippedShipment(providerData: Record<string, unknown> = {}) {
      const provider = await prisma.shippingProvider.create({
        data: {
          name: "Transporteur ref",
          type: "API",
          providerKey: REFERENCE_PROVIDER_KEY,
          credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_API_KEY })),
          connectionStatus: "CONFIGURE",
          ...providerData,
        },
      });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      await prisma.shipment.update({ where: { id: shipment.id }, data: { status: "EN_TRANSIT" } });
      await prisma.order.update({ where: { id: order.id }, data: { status: "EXPEDIEE" } });
      return { provider, order, shipment };
    }

    async function sync(shipmentId: string) {
      const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { order: true } });
      return syncShipmentStatus({ shipment: fresh, order: fresh.order, updatedById: testUserId });
    }

    it("a successful delivery records the CARRIER's price and freezes it — ASODITECH never invents one", async () => {
      const { shipment } = await shippedShipment();
      carrierState.shipments.get(shipment.externalId!)!.status = "delivered";
      await sync(shipment.id);

      const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(s.status).toBe("LIVRE");
      expect(Number(s.cost)).toBe(25.5); // the fake carrier's reported cost
      expect(s.costSource).toBe("CARRIER_API");
      expect(s.costFinalizedAt).not.toBeNull();
    });

    it("a delivery with NO carrier price stays 'unknown' — no default, no previous price, no guess", async () => {
      carrierState.reportedCost = null;
      const { shipment } = await shippedShipment({ returnCost: 10, failureCost: 5 });
      carrierState.shipments.get(shipment.externalId!)!.status = "delivered";
      await sync(shipment.id);

      const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(s.status).toBe("LIVRE");
      expect(s.cost).toBeNull();
      expect(s.costSource).toBeNull();
    });

    it("a return uses the provider's configured return cost — independent of the delivery price", async () => {
      const { shipment } = await shippedShipment({ returnCost: 10 });
      carrierState.shipments.get(shipment.externalId!)!.status = "returned";
      await sync(shipment.id);

      const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(s.status).toBe("RETOURNE");
      expect(Number(s.cost)).toBe(10); // return rule, NOT the carrier's 25.5, NOT 12.75
      expect(s.costSource).toBe("RETURN_RULE");
      expect(s.costFinalizedAt).not.toBeNull();
    });

    it("a failure uses the provider's configured failure cost (0 when unset)", async () => {
      const { shipment } = await shippedShipment(); // no failureCost configured
      carrierState.shipments.get(shipment.externalId!)!.status = "failed";
      await sync(shipment.id);

      const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(s.status).toBe("ECHEC");
      expect(Number(s.cost)).toBe(0);
      expect(s.costSource).toBe("FAILURE_RULE");
    });

    it("a historical shipment's cost never changes when the provider's rules change later", async () => {
      const { provider, shipment } = await shippedShipment({ returnCost: 10 });
      carrierState.shipments.get(shipment.externalId!)!.status = "returned";
      await sync(shipment.id);
      const before = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(Number(before.cost)).toBe(10);

      await prisma.shippingProvider.update({ where: { id: provider.id }, data: { returnCost: 25 } });

      const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(Number(after.cost)).toBe(10); // unchanged
    });

    it("a later carrier re-fetch never re-costs a shipment whose cost is already frozen", async () => {
      const { shipment } = await shippedShipment();
      carrierState.shipments.get(shipment.externalId!)!.status = "delivered";
      await sync(shipment.id);
      const frozen = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(Number(frozen.cost)).toBe(25.5);

      carrierState.shipments.get(shipment.externalId!)!.cost = 99;
      await sync(shipment.id);

      const still = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(Number(still.cost)).toBe(25.5); // frozen
    });

    async function outcomeUnknownShipment(providerData: Record<string, unknown>) {
      __resetDeliveryProviderRegistryForTests();
      registerDeliveryProvider({
        ...referenceDeliveryProvider,
        createShipment: async () => {
          throw new DeliveryOutcomeUnknownError("Résultat inconnu (test).");
        },
      });
      const provider = await prisma.shippingProvider.create({
        data: {
          name: "Transporteur ref",
          type: "API",
          providerKey: REFERENCE_PROVIDER_KEY,
          credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_API_KEY })),
          connectionStatus: "CONFIGURE",
          ...providerData,
        },
      });
      const order = await seedOrderWithAddress();
      await expect(createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null })).rejects.toBeInstanceOf(
        DeliveryOutcomeUnknownError
      );
      const pending = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
      expect(isShipmentOutcomeUnknown(pending)).toBe(true);
      return { provider, order, pending };
    }

    it.each(["ECHEC", "ANNULE"] as const)(
      "a creation « à vérifier » settled by hand as %s books NO failure fee (never a carrier parcel — ADR 0031/0032)",
      async (to) => {
        const { order, pending } = await outcomeUnknownShipment({ failureCost: 15 });
        const result = await applyShipmentStatusTransition({
          shipmentId: pending.id,
          currentStatus: "EN_ATTENTE",
          orderId: order.id,
          currentOrderStatus: order.status,
          newStatus: to,
          updatedById: testUserId,
          failedReason: "Aucun colis sur le portail",
        });
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.finalizedCost).toBeFalsy();
        const s = await prisma.shipment.findUniqueOrThrow({ where: { id: pending.id } });
        expect(s.status).toBe(to);
        expect(s.cost).toBeNull();
        expect(s.costSource).toBeNull();
      }
    );

    it("after « à vérifier » → ECHEC, the replacement parcel is created normally and the failed attempt (no fee) is cleaned up", async () => {
      const { provider, order, pending } = await outcomeUnknownShipment({ failureCost: 15 });
      await applyShipmentStatusTransition({
        shipmentId: pending.id,
        currentStatus: "EN_ATTENTE",
        orderId: order.id,
        currentOrderStatus: order.status,
        newStatus: "ECHEC",
        updatedById: testUserId,
        failedReason: "Aucun colis sur le portail",
      });
      __resetDeliveryProviderRegistryForTests();
      registerReferenceDeliveryProvider();
      const replacement = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      expect(replacement.externalId).toBe("ref-1");
      const rows = await prisma.shipment.findMany({ where: { orderId: order.id } });
      expect(rows.map((r) => r.id)).toEqual([replacement.id]);
      const deletedAudit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "shipment.deleted", entityId: order.id } });
      expect(deletedAudit.previousValue).toMatchObject({ shipmentId: pending.id, cost: null });
    });

    it("a carrier-reported ECHEC on a real parcel still books the failure rule", async () => {
      const { shipment } = await shippedShipment({ failureCost: 7 });
      carrierState.shipments.get(shipment.externalId!)!.status = "failed";
      await sync(shipment.id);
      const s = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(Number(s.cost)).toBe(7);
      expect(s.costSource).toBe("FAILURE_RULE");
    });
  });

  describe("one live parcel per order, stock deducted once", () => {
    it("a carrier ECHEC frees the order for a 2nd parcel; the 1st one moving again is refused while the 2nd is live — no second stock deduction", async () => {
      const provider = await seedApiProvider();
      const order = await seedOrderWithAddress();
      const first = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      const sync = async (id: string) => {
        const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id }, include: { order: true } });
        return syncShipmentStatus({ shipment: fresh, order: fresh.order, updatedById: testUserId });
      };
      carrierState.shipments.get(first.externalId!)!.status = "in_transit";
      await sync(first.id);
      carrierState.shipments.get(first.externalId!)!.status = "failed";
      await sync(first.id);
      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("ECHEC");
      const outAfterFirst = await prisma.inventoryMovement.count({ where: { orderId: order.id, type: "VENTE" } });
      expect(outAfterFirst).toBeGreaterThan(0);

      // Current rule (ADR 0006): an ECHEC parcel is not « active » — once staff
      // put the order « Échec » (re-ship case), a 2nd parcel is allowed.
      await prisma.order.update({ where: { id: order.id }, data: { status: "ECHEC" } });
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { customer: true } });
      const second = await createShipmentViaProvider({ order: fresh, providerId: provider.id, updatedById: testUserId, notes: null });
      expect(second.id).not.toBe(first.id);

      // The carrier then reports the FIRST parcel moving again: refused, never two live parcels.
      carrierState.shipments.get(first.externalId!)!.status = "in_transit";
      const result = await sync(first.id);
      expect(result).toMatchObject({ outcome: "error" });
      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("ECHEC");
      expect(await prisma.shipment.count({ where: { orderId: order.id, status: { in: ["EN_ATTENTE", "EN_TRANSIT"] } } })).toBe(1);

      // The 2nd parcel leaving does not deduct the order's stock a second time.
      carrierState.shipments.get(second.externalId!)!.status = "in_transit";
      await sync(second.id);
      expect(await prisma.inventoryMovement.count({ where: { orderId: order.id, type: "VENTE" } })).toBe(outAfterFirst);
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
      // The loser either sees the winner still EN_COURS (→ "in_progress",
      // the carrier is asked to retry) or already TRAITE. Since 2026-10-16
      // the row becomes TRAITE only after processing (before, it was written
      // TRAITE up front and the loser always answered "already_processed").
      expect([a.outcome, b.outcome].filter((o) => o === "processed")).toHaveLength(1);
      expect([a.outcome, b.outcome].filter((o) => o === "in_progress" || o === "already_processed")).toHaveLength(1);

      const events = await prisma.shipmentWebhookEvent.count({ where: { providerId: provider.id, deliveryId: "evt-concurrent" } });
      expect(events).toBe(1);
    });

    it("a failed processing stays ECHEC (never TRAITE); the carrier's retry of the same delivery is processed, once", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      const { raw, signature } = signedBody(
        { delivery_id: "evt-retry", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" },
        "whsec_1"
      );
      const params = { providerId: provider.id, rawBody: raw, headers: { "x-reference-signature": signature }, deliveryIdHeader: "evt-retry" };
      const eventStatus = async () =>
        (await prisma.shipmentWebhookEvent.findFirstOrThrow({ where: { providerId: provider.id, deliveryId: "evt-retry" } })).status;

      // The authoritative re-fetch fails (carrier answers 404 / down).
      const record = carrierState.shipments.get(shipment.externalId!)!;
      carrierState.shipments.delete(shipment.externalId!);
      const failed = await handleDeliveryWebhook(params);
      expect(failed.outcome).toBe("failed");
      expect(await eventStatus()).toBe("ECHEC");
      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe(shipment.status);

      // The carrier retries the SAME delivery once it is reachable again.
      carrierState.shipments.set(shipment.externalId!, { ...record, status: "in_transit" });
      const retried = await handleDeliveryWebhook(params);
      expect(retried.outcome).toBe("processed");
      expect(await eventStatus()).toBe("TRAITE");
      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("EN_TRANSIT");

      // A further replay is a no-op.
      expect(await handleDeliveryWebhook(params)).toEqual({ outcome: "already_processed" });
      expect(await prisma.shipmentWebhookEvent.count({ where: { providerId: provider.id, deliveryId: "evt-retry" } })).toBe(1);
    });

    it("an event claimed by a live request answers in_progress; a stale claim (dead request) is taken over", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      const { raw, signature } = signedBody(
        { delivery_id: "evt-claim", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" },
        "whsec_1"
      );
      const params = { providerId: provider.id, rawBody: raw, headers: { "x-reference-signature": signature }, deliveryIdHeader: "evt-claim" };
      await prisma.shipmentWebhookEvent.create({
        data: { providerId: provider.id, deliveryId: "evt-claim", topic: REFERENCE_WEBHOOK_TOPIC, resourceId: shipment.externalId, status: "EN_COURS" },
      });
      expect(await handleDeliveryWebhook(params)).toEqual({ outcome: "in_progress" });

      await prisma.shipmentWebhookEvent.updateMany({ where: { deliveryId: "evt-claim" }, data: { receivedAt: new Date(Date.now() - 10 * 60 * 1000) } });
      expect((await handleDeliveryWebhook(params)).outcome).toBe("processed");
    });

    it("a « returned » event delivered twice moves the order to RETOUR once, restores no stock, leaves payment alone", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      // The parcel went out, then came back.
      carrierState.shipments.get(shipment.externalId!)!.status = "in_transit";
      await handleDeliveryWebhook({
        providerId: provider.id,
        ...(() => {
          const s = signedBody({ delivery_id: "evt-transit", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" }, "whsec_1");
          return { rawBody: s.raw, headers: { "x-reference-signature": s.signature } };
        })(),
        deliveryIdHeader: "evt-transit",
      });
      carrierState.shipments.get(shipment.externalId!)!.status = "returned";
      const { raw, signature } = signedBody(
        { delivery_id: "evt-returned", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "returned" },
        "whsec_1"
      );
      const params = { providerId: provider.id, rawBody: raw, headers: { "x-reference-signature": signature }, deliveryIdHeader: "evt-returned" };
      const movementsBefore = await prisma.inventoryMovement.count({ where: { type: "RETOUR" } });

      expect((await handleDeliveryWebhook(params)).outcome).toBe("processed");
      expect(await handleDeliveryWebhook(params)).toEqual({ outcome: "already_processed" });
      // Same status re-delivered under a NEW delivery id: unchanged, still nothing restocked.
      const again = signedBody({ delivery_id: "evt-returned-2", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "returned" }, "whsec_1");
      await handleDeliveryWebhook({ providerId: provider.id, rawBody: again.raw, headers: { "x-reference-signature": again.signature }, deliveryIdHeader: "evt-returned-2" });

      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("RETOURNE");
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(after.paymentStatus).toBe(order.paymentStatus);
      // Restocking only happens at inspection in the returns workspace.
      expect(await prisma.inventoryMovement.count({ where: { type: "RETOUR" } })).toBe(movementsBefore);
      const toRetour = await prisma.auditEvent.count({
        where: { entityType: "Order", entityId: order.id, action: "order.status_changed", newValue: { path: ["status"], equals: "RETOUR" } },
      });
      expect(toRetour).toBeLessThanOrEqual(1);
    });

    it("a « delivered » event duplicated under DIFFERENT delivery ids (and concurrently) applies its effects once: one stock deduction, one Woo push, one audit, no new shipment", async () => {
      const provider = await seedApiProvider({ webhookSecret: "whsec_1" });
      const order = await seedOrderWithAddress();
      const shipment = await createShipmentViaProvider({ order, providerId: provider.id, updatedById: testUserId, notes: null });
      autoPush.pushOrderStatusToWooCommerce.mockClear();
      carrierState.shipments.get(shipment.externalId!)!.status = "delivered";
      const deliver = (id: string) => {
        const s = signedBody({ delivery_id: id, topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "delivered" }, "whsec_1");
        return handleDeliveryWebhook({ providerId: provider.id, rawBody: s.raw, headers: { "x-reference-signature": s.signature }, deliveryIdHeader: id });
      };

      await Promise.all([deliver("evt-d1"), deliver("evt-d2")]);
      await deliver("evt-d3");
      await deliver("evt-d1"); // exact replay

      expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("LIVRE");
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("LIVREE");
      expect(await prisma.shipment.count({ where: { orderId: order.id } })).toBe(1);
      expect(await prisma.inventoryMovement.count({ where: { orderId: order.id, type: "VENTE" } })).toBe(1);
      expect((await prisma.inventoryItem.findFirstOrThrow()).quantityOnHand).toBe(9);
      expect(await prisma.inventoryMovement.count({ where: { type: "RETOUR" } })).toBe(0);
      expect(autoPush.pushOrderStatusToWooCommerce).toHaveBeenCalledTimes(1);
      expect(
        await prisma.auditEvent.count({ where: { entityType: "Shipment", entityId: shipment.id, action: "shipment.status_changed" } })
      ).toBe(1);
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
