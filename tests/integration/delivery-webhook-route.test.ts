import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { prisma, prismaBase } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { runWithTenant } from "@/lib/tenant/context";
import { createShipmentViaProvider, handleDeliveryWebhook, fetchShipmentLabelViaProvider } from "@/lib/integrations/delivery/service";
import { registerDeliveryProvider, __resetDeliveryProviderRegistryForTests } from "@/lib/integrations/delivery/registry";
import { POST } from "@/app/api/webhooks/delivery/[providerId]/route";
import { registerReferenceDeliveryProvider, referenceDeliveryProvider, REFERENCE_PROVIDER_KEY, REFERENCE_WEBHOOK_TOPIC } from "../helpers/reference-delivery-provider";
import { installFakeReferenceCarrier, emptyFakeCarrierState, FAKE_API_KEY, type FakeCarrierState } from "../helpers/fake-reference-carrier";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

/**
 * Generic carrier webhook route /api/webhooks/delivery/[providerId] + the
 * optional ignore hook + the FETCH_LABEL capability (docs/adr/0060), against
 * the reference fixture adapter (HMAC-SHA256 base64 in x-reference-signature).
 */

const TENANT_B = "tenant-b-webhook";
let carrierState: FakeCarrierState;
let testUserId: string;

async function seedProvider(tenantId: string, webhookSecret: string) {
  return runWithTenant(tenantId, "test", () =>
    prisma.shippingProvider.create({
      data: {
        name: "Transporteur de référence",
        type: "API",
        providerKey: REFERENCE_PROVIDER_KEY,
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_API_KEY, webhookSecret })),
        connectionStatus: "CONFIGURE",
      },
    })
  );
}

async function seedShipment(providerId: string) {
  const warehouse = await prisma.warehouse.create({ data: { id: "wh-hook", name: "Entrepôt", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Produit", sku: "SKU-HOOK", price: 200, status: "ACTIF" } });
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
      items: { create: [{ productId: product.id, nameSnapshot: "Produit", skuSnapshot: "SKU-HOOK", quantity: 1, unitPrice: 200, total: 200 }] },
    },
    include: { customer: true },
  });
  return createShipmentViaProvider({ order, providerId, updatedById: testUserId, notes: null });
}

function signed(body: object, secret: string) {
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac("sha256", secret).update(raw, "utf8").digest("base64") };
}

function post(providerId: string, raw: string, signature?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["X-Reference-Signature"] = signature;
  return POST(new Request(`https://app.example/api/webhooks/delivery/${providerId}`, { method: "POST", body: raw, headers }), {
    params: Promise.resolve({ providerId }),
  });
}

beforeEach(async () => {
  await resetDb();
  registerReferenceDeliveryProvider();
  carrierState = emptyFakeCarrierState();
  installFakeReferenceCarrier(carrierState);
  testUserId = (await createTestUser({ role: "MANAGER" })).id;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  __resetDeliveryProviderRegistryForTests();
  registerReferenceDeliveryProvider();
  await resetDb();
});

describe("POST /api/webhooks/delivery/[providerId]", () => {
  it("a validly signed event is processed (200) via the authoritative re-fetch, and a replay is a no-op", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    carrierState.shipments.get(shipment.externalId!)!.status = "in_transit";
    const { raw, signature } = signed({ delivery_id: "evt-1", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" }, "whsec_a");

    expect((await post(provider.id, raw, signature)).status).toBe(200);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("EN_TRANSIT");

    expect((await post(provider.id, raw, signature)).status).toBe(200); // replay
    expect(await prismaBase.shipmentWebhookEvent.count({ where: { providerId: provider.id } })).toBe(1);
  });

  it("processing that fails answers 500 (event ECHEC, retryable); the retry is processed once and answers 200", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    const record = carrierState.shipments.get(shipment.externalId!)!;
    carrierState.shipments.delete(shipment.externalId!); // carrier status fetch fails
    const { raw, signature } = signed({ delivery_id: "evt-fail", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" }, "whsec_a");

    expect((await post(provider.id, raw, signature)).status).toBe(500);
    expect((await prismaBase.shipmentWebhookEvent.findFirstOrThrow({ where: { deliveryId: "evt-fail" } })).status).toBe("ECHEC");

    carrierState.shipments.set(shipment.externalId!, { ...record, status: "in_transit" });
    expect((await post(provider.id, raw, signature)).status).toBe(200);
    expect((await prismaBase.shipmentWebhookEvent.findFirstOrThrow({ where: { deliveryId: "evt-fail" } })).status).toBe("TRAITE");
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("EN_TRANSIT");
    expect((await post(provider.id, raw, signature)).status).toBe(200); // replay after success: no-op
  });

  it("unsigned, tampered or wrongly signed requests are refused with 401 and change nothing", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    const { raw, signature } = signed({ delivery_id: "evt-2", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "delivered" }, "whsec_a");
    expect((await post(provider.id, raw)).status).toBe(401);
    expect((await post(provider.id, raw + " ", signature)).status).toBe(401);
    const wrong = signed({ delivery_id: "evt-2", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "delivered" }, "not-the-secret");
    expect((await post(provider.id, wrong.raw, wrong.signature)).status).toBe(401);
    expect(await prismaBase.shipmentWebhookEvent.count()).toBe(0);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("EN_ATTENTE");
  });

  it("an unknown connection id gets the same 401 (no enumeration)", async () => {
    const { raw, signature } = signed({ delivery_id: "x", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "s", status: "delivered" }, "whsec_a");
    expect((await post("does-not-exist", raw, signature)).status).toBe(401);
  });

  it("tenant isolation: an event for tenant A's connection signed with tenant B's secret is refused", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const providerA = await seedProvider(DEFAULT_TENANT_ID, "whsec_tenant_a");
    await seedProvider(TENANT_B, "whsec_tenant_b");
    const { raw, signature } = signed({ delivery_id: "evt-x", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "ref-1", status: "delivered" }, "whsec_tenant_b");
    expect((await post(providerA.id, raw, signature)).status).toBe(401);
    expect(await prismaBase.shipmentWebhookEvent.count()).toBe(0);
  });

  it("a connection without a webhook secret refuses every event", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "");
    const { raw, signature } = signed({ delivery_id: "e", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "s", status: "delivered" }, "");
    expect((await post(provider.id, raw, signature)).status).toBe(401);
  });

  it("a suspended tenant's events are accepted (200) but not processed", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { status: "SUSPENDED" } });
    const { raw, signature } = signed({ delivery_id: "evt-s", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "ref-1", status: "delivered" }, "whsec_a");
    expect((await post(provider.id, raw, signature)).status).toBe(200);
    expect(await prismaBase.shipmentWebhookEvent.count()).toBe(0);
    // Verify-then-ignore (2026-10-16): an UNSIGNED request to a suspended
    // company's connection gets the same 401 as anyone (no existence signal).
    expect((await post(provider.id, raw)).status).toBe(401);
  });

  it("an update applied by webhook is audited like a manual sync (source provider_webhook)", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    carrierState.shipments.get(shipment.externalId!)!.status = "in_transit";
    const { raw, signature } = signed({ delivery_id: "evt-audit", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" }, "whsec_a");
    expect((await post(provider.id, raw, signature)).status).toBe(200);
    const audit = await prismaBase.auditEvent.findFirst({ where: { entityType: "Shipment", entityId: shipment.id, action: "shipment.status_changed" } });
    expect(audit).toMatchObject({ actorType: "INTEGRATION", newValue: { status: "EN_TRANSIT" }, metadata: { source: "provider_webhook", deliveryId: "evt-audit" } });
  });

  it("a carrier status that is an invalid local transition is acknowledged (TRAITE, 200), not retried forever", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    // Staff already closed the parcel; the carrier later reports « in transit ».
    await prismaBase.shipment.update({ where: { id: shipment.id }, data: { status: "ANNULE" } });
    carrierState.shipments.get(shipment.externalId!)!.status = "in_transit";
    const { raw, signature } = signed({ delivery_id: "evt-invalid", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: shipment.externalId, status: "in_transit" }, "whsec_a");
    expect((await post(provider.id, raw, signature)).status).toBe(200);
    expect((await prismaBase.shipmentWebhookEvent.findFirstOrThrow({ where: { deliveryId: "evt-invalid" } })).status).toBe("TRAITE");
    expect((await prismaBase.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("ANNULE");
  });

  it("a body over 1 MiB is refused with 413", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    expect((await post(provider.id, "x".repeat(1024 * 1024 + 1), "sig")).status).toBe(413);
  });
});

describe("shouldIgnoreWebhookEvent hook", () => {
  it("a verified event the adapter asks to ignore is not recorded nor processed", async () => {
    __resetDeliveryProviderRegistryForTests();
    registerDeliveryProvider({ ...referenceDeliveryProvider, shouldIgnoreWebhookEvent: () => "ignoré (test)" });
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const { raw, signature } = signed({ delivery_id: "evt-i", topic: REFERENCE_WEBHOOK_TOPIC, shipment_id: "ref-1", status: "delivered" }, "whsec_a");
    const outcome = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
      handleDeliveryWebhook({ providerId: provider.id, rawBody: raw, headers: { "x-reference-signature": signature }, deliveryIdHeader: null })
    );
    expect(outcome).toEqual({ outcome: "ignored", reason: "ignoré (test)" });
    expect(await prismaBase.shipmentWebhookEvent.count()).toBe(0);
  });
});

describe("FETCH_LABEL capability", () => {
  it("a connector without FETCH_LABEL refuses (typed) — of the real carriers only Sendit declares it", async () => {
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    await expect(fetchShipmentLabelViaProvider(shipment)).rejects.toThrow(/ne prend pas en charge/);
  });

  it("returns the carrier's https link on demand and never stores it", async () => {
    __resetDeliveryProviderRegistryForTests();
    registerDeliveryProvider({
      ...referenceDeliveryProvider,
      capabilities: [...referenceDeliveryProvider.capabilities, "FETCH_LABEL"],
      fetchLabel: async ({ externalId }) => ({ url: `https://labels.example.com/${externalId}?sig=abc` }),
    });
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    const url = await fetchShipmentLabelViaProvider(shipment);
    expect(url).toBe(`https://labels.example.com/${shipment.externalId}?sig=abc`);
    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
    expect(JSON.stringify(after)).not.toContain("labels.example.com");
  });

  it("refuses a non-https label link", async () => {
    __resetDeliveryProviderRegistryForTests();
    registerDeliveryProvider({
      ...referenceDeliveryProvider,
      capabilities: [...referenceDeliveryProvider.capabilities, "FETCH_LABEL"],
      fetchLabel: async () => ({ url: "http://labels.example.com/x" }),
    });
    const provider = await seedProvider(DEFAULT_TENANT_ID, "whsec_a");
    const shipment = await seedShipment(provider.id);
    await expect(fetchShipmentLabelViaProvider(shipment)).rejects.toThrow(/non sécurisé/);
  });
});
