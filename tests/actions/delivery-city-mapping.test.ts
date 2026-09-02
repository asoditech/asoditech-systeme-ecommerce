import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createShippingProviderAction,
  configureDeliveryProviderApiAction,
  createShipmentViaProviderAction,
  createDeliveryCityMappingAction,
  updateDeliveryCityMappingAction,
  deleteDeliveryCityMappingAction,
  getDeliveryCityMappingContextAction,
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

// No `cityIdByName` — so the generic mapping layer is the only override.
const CREDENTIALS_JSON = JSON.stringify({ customerId: FAKE_OZ_CUSTOMER_ID, apiKey: FAKE_OZ_API_KEY });
const CONFIG_JSON = JSON.stringify({ baseUrl: FAKE_OZ_BASE_URL, requestTimeoutMs: 1000 });

let state: FakeOzonExpressState;

async function seedApiProviderRow(name = "OzonExpress") {
  const created = await createShippingProviderAction(formData({ name, type: "API" }));
  if (!created.ok) throw new Error("setup failed");
  return created.data;
}

async function configuredProvider(name?: string) {
  const provider = await seedApiProviderRow(name);
  const res = await configureDeliveryProviderApiAction(
    formData({ providerId: provider.id, providerKey: OZONEXPRESS_PROVIDER_KEY, credentialsJson: CREDENTIALS_JSON, configJson: CONFIG_JSON })
  );
  if (!res.ok) throw new Error("configure failed");
  return provider;
}

async function seedShippableOrder(city: string) {
  const warehouse = await prisma.warehouse.upsert({
    where: { id: "wh-map" },
    update: {},
    create: { id: "wh-map", name: "Entrepôt", isDefault: true },
  });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-MAP-${Date.now()}-${Math.random()}`, price: 100, status: "ACTIF" },
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
    shippingCity: city,
    shippingRegion: "",
    shippingCountry: "MA",
    shippingPhone: "0600000000",
    items: [{ productId: product.id, quantity: 1, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error("setup failed");
  await updateOrderStatusAction(formData({ id: created.data.id, status: "CONFIRMEE" }));
  return created.data.id;
}

describe("generic delivery-provider city mapping — Server Action layer", () => {
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

  describe("authorization & provider boundary", () => {
    it("a user without delivery.manage cannot create, update or delete a mapping", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const created = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "1" })
      );
      expect(created.ok).toBe(true);
      const mappingId = created.ok ? created.data.id : "";

      mockCookieStore.clear();
      await loginAsTestUser({ role: "WAREHOUSE" }); // delivery.view but not delivery.manage

      await expect(
        createDeliveryCityMappingAction(formData({ providerId: provider.id, localCity: "Rabat", providerCityId: "2" }))
      ).rejects.toThrow();
      await expect(
        updateDeliveryCityMappingAction(formData({ id: mappingId, providerCityId: "2" }))
      ).rejects.toThrow();
      await expect(deleteDeliveryCityMappingAction(formData({ id: mappingId }))).rejects.toThrow();

      // untouched
      expect(await prisma.deliveryCityMapping.count()).toBe(1);
    });

    it("delivery.view is enough to read the mapping context", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      mockCookieStore.clear();
      await loginAsTestUser({ role: "WAREHOUSE" });
      const ctx = await getDeliveryCityMappingContextAction(formData({ providerId: provider.id }));
      expect(ctx.ok).toBe(true);
      if (ctx.ok) expect(ctx.data.catalogueSupported).toBe(true);
    });

    it("rejects a mapping against a non-existent provider", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const res = await createDeliveryCityMappingAction(
        formData({ providerId: "does-not-exist", localCity: "Casablanca", providerCityId: "1" })
      );
      expect(res).toMatchObject({ ok: false });
    });

    it("an update re-validates the provider city against the mapping's OWN provider catalogue", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const created = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "1" })
      );
      if (!created.ok) throw new Error("setup");
      const bad = await updateDeliveryCityMappingAction(
        formData({ id: created.data.id, providerCityId: "not-a-real-id" })
      );
      expect(bad).toMatchObject({ ok: false });
      const good = await updateDeliveryCityMappingAction(
        formData({ id: created.data.id, providerCityId: "2" })
      );
      expect(good.ok).toBe(true);
      const row = await prisma.deliveryCityMapping.findUniqueOrThrow({ where: { id: created.data.id } });
      expect(row.providerCityId).toBe("2");
      expect(row.providerCityName).toBe("Rabat"); // from catalogue, not the client
    });
  });

  describe("server-side validation", () => {
    it("a provider that exposes no catalogue cannot get a mapping — no fabricated id", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const manual = await createShippingProviderAction(formData({ name: "Manuel", type: "MANUEL" }));
      if (!manual.ok) throw new Error("setup");
      const res = await createDeliveryCityMappingAction(
        formData({ providerId: manual.data.id, localCity: "Casablanca", providerCityId: "whatever" })
      );
      expect(res).toMatchObject({ ok: false });
      expect(await prisma.deliveryCityMapping.count()).toBe(0);
    });

    it("an arbitrary providerCityId not in the catalogue is refused", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const res = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "999999" })
      );
      expect(res).toMatchObject({ ok: false });
      expect(await prisma.deliveryCityMapping.count()).toBe(0);
    });

    it("providerCityName is taken from the catalogue, never from the client", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const res = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casa", providerCityId: "1", providerCityName: "HACKED" })
      );
      expect(res.ok).toBe(true);
      const row = await prisma.deliveryCityMapping.findFirstOrThrow({ where: { shippingProviderId: provider.id } });
      expect(row.providerCityName).toBe("Casablanca");
    });
  });

  describe("integrity & concurrency", () => {
    it("a duplicate mapping for the same (provider, local city) is refused", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const a = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "1" })
      );
      expect(a.ok).toBe(true);
      const b = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "  casablanca ", providerCityId: "2" })
      );
      expect(b).toMatchObject({ ok: false });
      expect(await prisma.deliveryCityMapping.count()).toBe(1);
    });

    it("two concurrent creates for the same city produce exactly one row", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const [r1, r2] = await Promise.all([
        createDeliveryCityMappingAction(formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "1" })),
        createDeliveryCityMappingAction(formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "2" })),
      ]);
      expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
      expect(await prisma.deliveryCityMapping.count()).toBe(1);
    });

    it("the same local city maps independently for two different providers", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const a = await configuredProvider("OZ A");
      const b = await configuredProvider("OZ B");
      const ra = await createDeliveryCityMappingAction(
        formData({ providerId: a.id, localCity: "Casablanca", providerCityId: "1" })
      );
      const rb = await createDeliveryCityMappingAction(
        formData({ providerId: b.id, localCity: "Casablanca", providerCityId: "2" })
      );
      expect(ra.ok && rb.ok).toBe(true);
      expect(await prisma.deliveryCityMapping.count()).toBe(2);
    });
  });

  describe("mutations & audit", () => {
    it("create, update and delete each write an audit event", async () => {
      const user = await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const created = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "1" })
      );
      if (!created.ok) throw new Error("setup");
      await updateDeliveryCityMappingAction(formData({ id: created.data.id, providerCityId: "2" }));
      await deleteDeliveryCityMappingAction(formData({ id: created.data.id }));

      const events = await prisma.auditEvent.findMany({
        where: { entityType: "DeliveryCityMapping", actorUserId: user.id },
        orderBy: { createdAt: "asc" },
      });
      expect(events.map((e) => e.action)).toEqual([
        "delivery_city_mapping.created",
        "delivery_city_mapping.updated",
        "delivery_city_mapping.deleted",
      ]);
      // no secret material in the audit payloads
      const blob = JSON.stringify(events);
      expect(blob).not.toContain(FAKE_OZ_API_KEY);
      expect(blob).not.toContain(FAKE_OZ_CUSTOMER_ID);
    });
  });

  describe("shipment creation integration", () => {
    it("an explicit mapping is used verbatim — the mapped provider city id is what reaches the carrier", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      // Casablanca would auto-match catalogue id "1"; pin it to "3" to prove
      // the explicit mapping wins and is sent verbatim.
      const m = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Casablanca", providerCityId: "3" })
      );
      expect(m.ok).toBe(true);

      const orderId = await seedShippableOrder("Casablanca");
      const res = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(res.ok).toBe(true);

      expect(state.seenAddParcelForms).toHaveLength(1);
      expect(state.seenAddParcelForms[0]["parcel-city"]).toBe("3");
    });

    it("a safe catalogue match still resolves when there is no mapping", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder("Rabat");
      const res = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(res.ok).toBe(true);
      expect(state.seenAddParcelForms[0]["parcel-city"]).toBe("2");
    });

    it("an unresolved city fails locally and creates NO external parcel", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder("Ifrane"); // not in catalogue, no mapping
      const res = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(res).toMatchObject({ ok: false });

      // no add-parcel call whatsoever
      expect(state.seenAddParcelForms).toHaveLength(0);
      expect(state.seenUrls.some((u) => u.includes("/add-parcel"))).toBe(false);
      expect(state.parcels.size).toBe(0);

      // local shipment row, if any, is ECHEC — never a live parcel
      const shipments = await prisma.shipment.findMany({ where: { orderId } });
      for (const s of shipments) {
        expect(s.status).toBe("ECHEC");
        expect(s.externalId).toBeNull();
      }
    });

    it("adding a mapping turns a previously-unresolved city into a successful shipment", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const provider = await configuredProvider();
      const orderId = await seedShippableOrder("Ifrane");

      const first = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(first.ok).toBe(false);

      const m = await createDeliveryCityMappingAction(
        formData({ providerId: provider.id, localCity: "Ifrane", providerCityId: "4" })
      );
      expect(m.ok).toBe(true);

      const retry = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.id }));
      expect(retry.ok).toBe(true);
      const sent = state.seenAddParcelForms.at(-1)!["parcel-city"];
      expect(sent).toBe("4");
    });
  });
});
