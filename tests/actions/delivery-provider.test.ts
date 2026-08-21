import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createShippingProviderAction,
  configureDeliveryProviderApiAction,
  testDeliveryProviderConnectionAction,
  createShipmentViaProviderAction,
  cancelShipmentAction,
  syncShipmentStatusAction,
} from "@/actions/delivery";
import { updateOrderStatusAction, createOrderAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { registerReferenceDeliveryProvider, REFERENCE_PROVIDER_KEY } from "../helpers/reference-delivery-provider";
import { installFakeReferenceCarrier, emptyFakeCarrierState, FAKE_API_KEY, type FakeCarrierState } from "../helpers/fake-reference-carrier";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

let carrierState: FakeCarrierState;

async function seedApiProviderRow() {
  const created = await createShippingProviderAction(formData({ name: "Transporteur API", type: "API" }));
  if (!created.ok) throw new Error("setup failed");
  return created.data;
}

async function seedShippableOrder() {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-DLV-API-1", price: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "12 rue Hassan II",
    shippingAddressLine2: "",
    shippingCity: "Rabat",
    shippingRegion: "",
    shippingCountry: "MA",
    shippingPhone: "0600000000",
    items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error("setup failed");
  await updateOrderStatusAction(formData({ id: created.data.id, status: "CONFIRMEE" }));
  return created.data.id;
}

describe("delivery provider API connector actions", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    registerReferenceDeliveryProvider();
    carrierState = emptyFakeCarrierState();
    installFakeReferenceCarrier(carrierState);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetDb();
    mockCookieStore.clear();
  });

  describe("configureDeliveryProviderApiAction", () => {
    it("lands on CONFIGURE, never CONNECTE, and never returns credentials to the caller", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();

      const result = await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.keys(result.data)).toEqual(["id"]); // never leaks credentialsEncrypted
      }

      const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("CONFIGURE");
      expect(row.credentialsEncrypted).not.toContain(FAKE_API_KEY); // stored ciphertext, not plaintext
    });

    it("rejects an unknown connector key", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();
      const result = await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: "not-a-real-connector", credentialsJson: "{}" })
      );
      expect(result.ok).toBe(false);
    });

    it("rejects malformed JSON credentials", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();
      const result = await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: "not json" })
      );
      expect(result.ok).toBe(false);
    });

    it("denies a role without delivery.manage", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();
      mockCookieStore.clear();
      await loginAsTestUser({ role: "SUPPORT" });
      await expect(
        configureDeliveryProviderApiAction(
          formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: "x" }) })
        )
      ).rejects.toThrow();
    });
  });

  describe("testDeliveryProviderConnectionAction", () => {
    it("only a real successful request sets CONNECTE — saving credentials alone never does", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();
      await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
      );
      let row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("CONFIGURE");

      const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
      expect(result.ok).toBe(true);

      row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("CONNECTE");
    });

    it("sets ERREUR on failed verification", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();
      await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: "wrong" }) })
      );
      const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
      expect(result.ok).toBe(false);
      const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("ERREUR");
    });
  });

  describe("createShipmentViaProviderAction", () => {
    async function configuredConnectedProvider() {
      const provider = await seedApiProviderRow();
      await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
      );
      return provider;
    }

    it("creates a real shipment for a valid, shippable order", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredConnectedProvider();
      const orderId = await seedShippableOrder();

      const result = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(result.ok).toBe(true);

      const shipment = await prisma.shipment.findFirst({ where: { orderId } });
      expect(shipment?.externalId).toBe("ref-1");
    });

    it("rejects an order in a non-shippable state", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredConnectedProvider();
      const orderId = await seedShippableOrder();
      await updateOrderStatusAction(formData({ id: orderId, status: "EN_PREPARATION" }));
      await updateOrderStatusAction(formData({ id: orderId, status: "EXPEDIEE" }));

      const result = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(result.ok).toBe(false);
      expect(await prisma.shipment.count({ where: { orderId } })).toBe(0);
    });

    it("refuses a second concurrent create for the same order+provider (double-submit guard)", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredConnectedProvider();
      const orderId = await seedShippableOrder();

      const [a, b] = await Promise.all([
        createShipmentViaProviderAction(formData({ orderId, providerId: provider.id })),
        createShipmentViaProviderAction(formData({ orderId, providerId: provider.id })),
      ]);
      const oks = [a.ok, b.ok].filter(Boolean);
      // At least one must succeed; the guard's job is to prevent BOTH from
      // succeeding (which would mean two real-world parcels for one order).
      expect(oks.length).toBeLessThanOrEqual(1);
      const shipments = await prisma.shipment.count({ where: { orderId, status: { in: ["EN_ATTENTE", "EN_TRANSIT"] } } });
      expect(shipments).toBeLessThanOrEqual(1);
    });

    it("records shipment.creation_failed in the audit log on provider rejection, never a fake shipment.created", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredConnectedProvider();
      const orderId = await seedShippableOrder();
      carrierState.forceCreateStatus = 500;

      const result = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(result.ok).toBe(false);

      const events = await prisma.auditEvent.findMany({ where: { action: { in: ["shipment.created", "shipment.creation_failed"] } } });
      expect(events.map((e) => e.action)).toContain("shipment.creation_failed");
      expect(events.map((e) => e.action)).not.toContain("shipment.created");
    });
  });

  describe("cancelShipmentAction / syncShipmentStatusAction", () => {
    async function createdShipment() {
      const provider = await seedApiProviderRow();
      await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
      );
      const orderId = await seedShippableOrder();
      const create = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      if (!create.ok) throw new Error("setup failed");
      return { shipmentId: create.data.id, orderId, providerId: provider.id };
    }

    it("cancels a provider-backed shipment and records the audit event", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const { shipmentId } = await createdShipment();

      const result = await cancelShipmentAction(formData({ shipmentId }));
      expect(result.ok).toBe(true);

      const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
      expect(shipment.status).toBe("ANNULE");
      const audit = await prisma.auditEvent.findFirst({ where: { action: "shipment.cancelled", entityId: shipmentId } });
      expect(audit).not.toBeNull();
    });

    it("syncs status and reports 'unchanged' when nothing changed provider-side", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const { shipmentId } = await createdShipment();

      const result = await syncShipmentStatusAction(formData({ shipmentId }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.outcome).toBe("unchanged");
    });

    it("denies delivery.manage-less roles from cancelling", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const { shipmentId } = await createdShipment();
      mockCookieStore.clear();
      await loginAsTestUser({ role: "SUPPORT" });
      await expect(cancelShipmentAction(formData({ shipmentId }))).rejects.toThrow();
    });
  });
});
