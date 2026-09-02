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
import { loginAsTestUser, createTestUser } from "../helpers/auth";
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

    // Phase 27B — city-resolution diagnostics surfaced through the
    // connection test itself (docs/adr/0013-ozonexpress-integration.md).
    describe("city-resolution diagnostics", () => {
      async function connectedProviderWithCities(cities: { id: string; name: string }[]) {
        const provider = await seedApiProviderRow();
        await configureDeliveryProviderApiAction(
          formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
        );
        carrierState.cities = cities;
        return provider;
      }

      it("stays silent (no city keys) when every pending order's city resolves", async () => {
        await loginAsTestUser({ role: "MANAGER" });
        await seedShippableOrder(); // shippingCity: "Rabat"
        const provider = await connectedProviderWithCities([{ id: "2", name: "Rabat" }]);

        const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.details?.["villes de commandes non résolues"]).toBeUndefined();
        expect(result.data.details?.["villes de commandes ambiguës"]).toBeUndefined();
      });

      it("reports an unresolved pending-order city without failing the connection test", async () => {
        await loginAsTestUser({ role: "MANAGER" });
        await seedShippableOrder(); // shippingCity: "Rabat"
        const provider = await connectedProviderWithCities([{ id: "1", name: "Casablanca" }]); // no Rabat

        const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.status).toBe("CONNECTE"); // diagnostic never turns a real success into a failure
        expect(result.data.details?.["villes de commandes non résolues"]).toBe("Rabat");

        const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
        expect(row.connectionStatus).toBe("CONNECTE");
      });

      it("reports an ambiguous pending-order city — never silently picks one", async () => {
        await loginAsTestUser({ role: "MANAGER" });
        await seedShippableOrder(); // shippingCity: "Rabat"
        const provider = await connectedProviderWithCities([
          { id: "2", name: "Rabat" },
          { id: "22", name: "RABAT" }, // normalizes the same — a real carrier data issue
        ]);

        const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.details?.["villes de commandes ambiguës"]).toBe("Rabat");
      });

      it("still reports an unresolved city for an order whose only shipment attempt already failed (live-test regression)", async () => {
        // Found live during Phase 27B: an order retrying after a failed
        // shipment attempt (status ECHEC, no external parcel — exactly
        // what a rejected city resolution produces) was invisible to this
        // diagnostic, because it reused the "awaiting first shipment"
        // query, which excludes any order that already has a Shipment
        // row of any status. The diagnostic must track exactly what
        // createShipmentViaProviderAction itself would accept — an ECHEC
        // shipment (no external id) never blocks a fresh attempt. The
        // reference fixture adapter has no city-resolution concept of its
        // own (that's OzonExpress-specific), so the failed attempt is
        // seeded directly, exactly like a real one would leave behind.
        await loginAsTestUser({ role: "MANAGER" });
        const orderId = await seedShippableOrder(); // shippingCity: "Rabat"
        const provider = await connectedProviderWithCities([{ id: "1", name: "Casablanca" }]); // no Rabat

        await prisma.shipment.create({
          data: {
            orderId,
            providerId: provider.id,
            status: "ECHEC",
            failedReason: "« Rabat » ne correspond à aucune ville desservie.",
          },
        });

        const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.details?.["villes de commandes non résolues"]).toBe("Rabat");
      });

      it("excludes an order that already has a live shipment (EN_ATTENTE) on this provider", async () => {
        await loginAsTestUser({ role: "MANAGER" });
        const orderId = await seedShippableOrder(); // shippingCity: "Rabat"
        const provider = await connectedProviderWithCities([{ id: "1", name: "Casablanca" }]); // no Rabat

        await prisma.shipment.create({
          data: { orderId, providerId: provider.id, status: "EN_ATTENTE", externalId: "ext-1" },
        });

        const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // A real parcel is already pending for this order+provider — a
        // fresh createShipmentViaProviderAction call would itself be
        // refused, so there's nothing useful to flag here.
        expect(result.data.details?.["villes de commandes non résolues"]).toBeUndefined();
      });

      it("does not add city keys when the adapter reports no catalogue at all", async () => {
        await loginAsTestUser({ role: "MANAGER" });
        await seedShippableOrder();
        const provider = await connectedProviderWithCities([]); // empty catalogue — nothing to diagnose against

        const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.details?.["villes de commandes non résolues"]).toBeUndefined();
      });
    });

    it("sets ERREUR on failed verification", async () => {
      const actor = await loginAsTestUser({ role: "MANAGER" });
      const teammate = await createTestUser({ role: "WAREHOUSE" }); // also holds delivery.view
      const provider = await seedApiProviderRow();
      await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: "wrong" }) })
      );
      const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
      expect(result.ok).toBe(false);
      const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("ERREUR");

      // docs/adr/0016-notifications.md — delivery.view holders are alerted,
      // the acting user is not.
      const notifications = await prisma.notification.findMany();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("ERREUR_INTEGRATION");
      expect(notifications[0].userId).toBe(teammate.id);
      expect(notifications.map((n) => n.userId)).not.toContain(actor.id);
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

    /**
     * Phase 30 hardening: this used to assert only `toBeLessThanOrEqual(1)`
     * — a best-effort expectation, because the guard at the time was a
     * plain `findFirst` pre-check that two concurrent requests could both
     * pass before either committed. reserveShipmentSlot's advisory-locked
     * transaction (src/lib/integrations/delivery/service.ts) makes this a
     * real guarantee now, not a probabilistic one — tightened to `toBe`.
     */
    it("refuses a second concurrent create for the same order+provider (double-submit guard)", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredConnectedProvider();
      const orderId = await seedShippableOrder();

      const [a, b] = await Promise.all([
        createShipmentViaProviderAction(formData({ orderId, providerId: provider.id })),
        createShipmentViaProviderAction(formData({ orderId, providerId: provider.id })),
      ]);
      const results = [a, b];
      // Exactly one must succeed — never both (two real-world parcels for
      // one order) and never zero (a legitimate request must not be
      // starved by the lock).
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
      const shipments = await prisma.shipment.count({ where: { orderId, status: { in: ["EN_ATTENTE", "EN_TRANSIT"] } } });
      expect(shipments).toBe(1);
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
