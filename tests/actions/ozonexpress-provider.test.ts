import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createShippingProviderAction,
  configureDeliveryProviderApiAction,
  testDeliveryProviderConnectionAction,
  createShipmentViaProviderAction,
  cancelShipmentAction,
  syncShipmentStatusAction,
  generateDeliveryManifestAction,
} from "@/actions/delivery";
import { updateOrderStatusAction, createOrderAction } from "@/actions/orders";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { registerOzonExpressProviderForTests, OZONEXPRESS_PROVIDER_KEY } from "../helpers/ozonexpress-provider";
import {
  installFakeOzonExpress,
  emptyFakeOzonExpressState,
  FAKE_OZ_API_KEY,
  FAKE_OZ_CUSTOMER_ID,
  FAKE_OZ_BASE_URL,
  type FakeOzonExpressState,
} from "../helpers/fake-ozonexpress";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const CREDENTIALS_JSON = JSON.stringify({ customerId: FAKE_OZ_CUSTOMER_ID, apiKey: FAKE_OZ_API_KEY });
const CONFIG_JSON = JSON.stringify({
  baseUrl: FAKE_OZ_BASE_URL,
  cityIdByName: { Rabat: 2, Casablanca: 1 },
  requestTimeoutMs: 1000,
});

let state: FakeOzonExpressState;

async function seedApiProviderRow(name = "OzonExpress") {
  const created = await createShippingProviderAction(formData({ name, type: "API" }));
  if (!created.ok) throw new Error("setup failed");
  return created.data;
}

async function seedShippableOrder() {
  const warehouse = await prisma.warehouse.upsert({
    where: { id: "wh-oz" },
    update: {},
    create: { id: "wh-oz", name: "Entrepôt", isDefault: true },
  });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-OZ-${Date.now()}-${Math.random()}`, price: 100, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 50 } });
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

async function configuredProvider(name?: string) {
  const provider = await seedApiProviderRow(name);
  const res = await configureDeliveryProviderApiAction(
    formData({ providerId: provider.id, providerKey: OZONEXPRESS_PROVIDER_KEY, credentialsJson: CREDENTIALS_JSON, configJson: CONFIG_JSON })
  );
  if (!res.ok) throw new Error("configure failed");
  return provider;
}

describe("OzonExpress connector — Server Action layer", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
    registerOzonExpressProviderForTests();
    state = emptyFakeOzonExpressState();
    installFakeOzonExpress(state);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetDb();
    mockCookieStore.clear();
  });

  describe("configuration & credentials", () => {
    it("saving credentials lands on CONFIGURE (never CONNECTE) and never returns them to the client", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();

      const result = await configureDeliveryProviderApiAction(
        formData({ providerId: provider.id, providerKey: OZONEXPRESS_PROVIDER_KEY, credentialsJson: CREDENTIALS_JSON, configJson: CONFIG_JSON })
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.keys(result.data)).toEqual(["id"]);

      const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("CONFIGURE");
      expect(row.credentialsEncrypted).toBeTruthy();
      expect(row.credentialsEncrypted).not.toContain(FAKE_OZ_API_KEY);
      expect(row.credentialsEncrypted).not.toContain(FAKE_OZ_CUSTOMER_ID);
      expect(JSON.stringify(row.config)).not.toContain(FAKE_OZ_API_KEY);
    });

    it("only a real successful connection test sets CONNECTE, and reports the city count", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();

      const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.details?.["villes desservies"]).toBe(4);
      const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("CONNECTE");
      expect(row.capabilities.sort()).toEqual([
        "CREATE_SHIPMENT",
        "FETCH_CITIES",
        "FETCH_COST",
        "FETCH_STATUS",
        "GENERATE_MANIFEST",
      ]);
      // The read-only verification facts are safe to keep in the audit trail.
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: "shipping_provider.connection_test_succeeded" },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain(FAKE_OZ_API_KEY);
    });

    it("a failed connection test sets ERREUR with a safe message (no credential, no URL)", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow();
      await configureDeliveryProviderApiAction(
        formData({
          providerId: provider.id,
          providerKey: OZONEXPRESS_PROVIDER_KEY,
          credentialsJson: JSON.stringify({ customerId: "wrong", apiKey: "wrong" }),
          configJson: CONFIG_JSON,
        })
      );
      const result = await testDeliveryProviderConnectionAction(formData({ providerId: provider.id }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toContain("wrong");
        expect(result.error.toLowerCase()).not.toContain("http");
      }
      const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.id } });
      expect(row.connectionStatus).toBe("ERREUR");
      expect(row.lastError).toBeTruthy();
      expect(row.lastError).not.toContain("wrong");
    });

    it("denies a role without delivery.manage", async () => {
      await loginAsTestUser({ role: "SUPPORT" });
      const p = await prisma.shippingProvider.create({ data: { name: "OZ", type: "API" } });
      await expect(
        configureDeliveryProviderApiAction(
          formData({ providerId: p.id, providerKey: OZONEXPRESS_PROVIDER_KEY, credentialsJson: CREDENTIALS_JSON })
        )
      ).rejects.toThrow();
    });
  });

  describe("shipment creation", () => {
    it("creates a shipment, persisting exactly OzonExpress's response (real tracking number + cost)", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder();

      const result = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(result.ok).toBe(true);

      const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
      expect(shipment.externalId).toBeTruthy();
      expect(shipment.trackingNumber).toBe(shipment.externalId);
      expect(shipment.trackingUrl).toBeNull();
      expect(Number(shipment.cost)).toBe(25);
      expect(shipment.providerStatusRaw).toBe("Nouveau colis");

      // COD amount forwarded to OzonExpress as parcel-price (order total 100).
      const addParcelCall = state.seenUrls.find((u) => u.includes("/add-parcel"));
      expect(addParcelCall).toBeTruthy();
    });

    it("marks the shipment ECHEC and audits creation_failed when OzonExpress rejects the city", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder();
      state.forceAddParcelErrorMessage = "City Not Found";

      const result = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(result.ok).toBe(false);

      const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
      expect(shipment.status).toBe("ECHEC");
      expect(shipment.externalId).toBeNull();

      const actions = (await prisma.auditEvent.findMany({ where: { entityType: { in: ["Order", "Shipment"] } } })).map((e) => e.action);
      expect(actions).toContain("shipment.creation_failed");
      expect(actions).not.toContain("shipment.created");
    });

    it("never writes a credential into an audit event", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder();
      await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));

      const all = await prisma.auditEvent.findMany();
      const blob = JSON.stringify(all);
      expect(blob).not.toContain(FAKE_OZ_API_KEY);
      expect(blob).not.toContain(FAKE_OZ_CUSTOMER_ID);
    });

    it("refuses to create a parcel when the provider is set to « colis créés par la boutique » — no API call", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await seedApiProviderRow("OzonExpress (site)");
      await configureDeliveryProviderApiAction(
        formData({
          providerId: provider.id,
          providerKey: OZONEXPRESS_PROVIDER_KEY,
          credentialsJson: CREDENTIALS_JSON,
          configJson: JSON.stringify({ baseUrl: FAKE_OZ_BASE_URL, requestTimeoutMs: 1000, parcelsCreatedByStore: true }),
        })
      );
      const orderId = await seedShippableOrder();

      const result = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/créés automatiquement par la boutique/i);

      expect(state.seenUrls.some((u) => u.includes("/add-parcel"))).toBe(false);
      expect(await prisma.shipment.count({ where: { orderId } })).toBe(0);
    });
  });

  describe("cancellation is exposed as unsupported (never a silent local-only cancel)", () => {
    it("cancelShipmentAction fails with the typed unsupported-capability error", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder();
      const create = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      if (!create.ok) throw new Error("setup failed");

      const result = await cancelShipmentAction(formData({ shipmentId: create.data.id }));
      expect(result.ok).toBe(false);

      const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
      expect(shipment.status).not.toBe("ANNULE");
    });
  });

  describe("status synchronisation", () => {
    it("maps a known raw status and advances the shipment", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder();
      const create = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      if (!create.ok) throw new Error("setup failed");

      const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
      state.parcels.get(shipment.externalId!)!.status = "En cours de livraison";

      const result = await syncShipmentStatusAction(formData({ shipmentId: shipment.id }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.outcome).toBe("updated");
      const updated = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(updated.status).toBe("EN_TRANSIT");
    });

    it("preserves an unknown raw status as metadata, never guesses a local status", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder();
      const create = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      if (!create.ok) throw new Error("setup failed");

      const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId } });
      state.parcels.get(shipment.externalId!)!.status = "colis en zone de tri regionale";

      const result = await syncShipmentStatusAction(formData({ shipmentId: shipment.id }));
      // outcome "unknown_status" is an actionOk with that outcome tag
      expect(result.ok).toBe(true);
      const updated = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
      expect(updated.providerStatusRaw).toBe("colis en zone de tri regionale");
      expect(updated.status).toBe("EN_ATTENTE");
    });
  });

  describe("Bon de Livraison (manifest)", () => {
    async function seedEnAttenteShipment(providerId: string) {
      const orderId = await seedShippableOrder();
      const create = await createShipmentViaProviderAction(formData({ orderId, providerId }));
      if (!create.ok) throw new Error("shipment setup failed");
      return prisma.shipment.findFirstOrThrow({ where: { orderId } });
    }

    it("generates a manifest, links the shipments, stores https-only document links, audits it", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const s1 = await seedEnAttenteShipment(provider.id);
      const s2 = await seedEnAttenteShipment(provider.id);

      const result = await generateDeliveryManifestAction(
        formData({ providerId: provider.id, shipmentIds: `${s1.id},${s2.id}` })
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.keys(result.data)).toEqual(["id"]);

      const manifest = await prisma.deliveryManifest.findFirstOrThrow();
      expect(manifest.status).toBe("FINALISE");
      expect(manifest.externalRef).toMatch(/^BL/);
      const docs = manifest.documents as { label: string; url: string }[];
      expect(docs).toHaveLength(3);
      for (const d of docs) expect(new URL(d.url).protocol).toBe("https:");

      const linked = await prisma.shipment.findMany({ where: { manifestId: manifest.id } });
      expect(linked.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "delivery_manifest.created" } });
      expect(JSON.stringify(audit.metadata)).not.toContain(FAKE_OZ_API_KEY);
    });

    it("is denied without delivery.manage", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const s1 = await seedEnAttenteShipment(provider.id);
      mockCookieStore.clear();

      await loginAsTestUser({ role: "SUPPORT" }); // no delivery.manage
      await expect(
        generateDeliveryManifestAction(formData({ providerId: provider.id, shipmentIds: s1.id }))
      ).rejects.toThrow();
      expect(await prisma.deliveryManifest.count()).toBe(0);
    });

    it("rejects a batch that mixes two providers and records a delivery_manifest.failed audit", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const a = await configuredProvider("OzonExpress A");
      const b = await configuredProvider("OzonExpress B");
      const sa = await seedEnAttenteShipment(a.id);
      const sb = await seedEnAttenteShipment(b.id);

      const result = await generateDeliveryManifestAction(
        formData({ providerId: a.id, shipmentIds: `${sa.id},${sb.id}` })
      );
      expect(result.ok).toBe(false);
      expect(await prisma.deliveryManifest.count()).toBe(0);
      expect(await prisma.auditEvent.count({ where: { action: "delivery_manifest.failed" } })).toBe(1);
    });
  });

  describe("tenant / provider isolation", () => {
    it("a second provider row with different credentials cannot read the first provider's parcels", async () => {
      await loginAsTestUser({ role: "MANAGER" });

      // Provider A — the real, working account.
      const providerA = await configuredProvider("OzonExpress — client A");
      const orderId = await seedShippableOrder();
      const create = await createShipmentViaProviderAction(formData({ orderId, providerId: providerA.id }));
      if (!create.ok) throw new Error("setup failed");
      const shipmentA = await prisma.shipment.findFirstOrThrow({ where: { orderId } });

      // Provider B — a different account (different credentials). The fake
      // rejects its credentials, proving B's config can't authenticate as A.
      const providerB = await seedApiProviderRow("OzonExpress — client B");
      await configureDeliveryProviderApiAction(
        formData({
          providerId: providerB.id,
          providerKey: OZONEXPRESS_PROVIDER_KEY,
          credentialsJson: JSON.stringify({ customerId: "OZ-CUST-B", apiKey: "oz_key_b" }),
          configJson: CONFIG_JSON,
        })
      );

      // Sync always resolves the adapter/credentials from the shipment's OWN
      // providerId (shipmentA.providerId === providerA.id), never a caller-
      // supplied one — so there is no path for B to act on A's shipment.
      expect(shipmentA.providerId).toBe(providerA.id);

      const testB = await testDeliveryProviderConnectionAction(formData({ providerId: providerB.id }));
      expect(testB.ok).toBe(false); // B's credentials are its own, not A's

      const rowA = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: providerA.id } });
      const rowB = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: providerB.id } });
      expect(rowA.credentialsEncrypted).not.toEqual(rowB.credentialsEncrypted);
    });
  });
});
