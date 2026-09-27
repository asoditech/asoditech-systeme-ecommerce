import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createShippingProviderAction,
  configureDeliveryProviderApiAction,
  createShipmentViaProviderAction,
  cancelShipmentAction,
} from "@/actions/delivery";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { listShipmentProviderOptions, providerCapabilities } from "@/lib/queries/delivery";
import { getCurrentUser } from "@/lib/auth/session";
import { hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { registerReferenceDeliveryProvider, REFERENCE_PROVIDER_KEY } from "../helpers/reference-delivery-provider";
import { installFakeReferenceCarrier, emptyFakeCarrierState, FAKE_API_KEY, type FakeCarrierState } from "../helpers/fake-reference-carrier";

/**
 * Batch 19 (E2E V2) — Batch 18 ("Delivery Provider UX Decoupling") proved
 * live in the browser that the generic UI correctly HIDES a capability
 * OzonExpress/Aramex don't declare (FETCH_CITIES for Aramex, CANCEL_SHIPMENT
 * for both — neither registered production adapter supports cancellation
 * today). What that batch could NOT prove live — no production adapter
 * declares CANCEL_SHIPMENT — is the other half of the same claim: that the
 * gate genuinely SHOWS the affordance for a provider whose adapter DOES
 * declare it, and that the affordance isn't just cosmetically present but
 * backed by a real, working `cancelShipmentAction` call.
 *
 * The `[TEST] Connecteur de référence` fixture adapter (test-only, never
 * reachable from a production build — docs/adr/0012) declares
 * CREATE_SHIPMENT / CANCEL_SHIPMENT / FETCH_STATUS / FETCH_TRACKING /
 * FETCH_COST / WEBHOOKS / GENERATE_MANIFEST, and deliberately NOT
 * FETCH_CITIES — the exact opposite cancellation profile from OzonExpress/
 * Aramex, closing the loop this batch's Phase 12 asks for.
 */
function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

let carrierState: FakeCarrierState;

async function seedShippableOrder() {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const actor = await getCurrentUser();
  if (actor && !hasGlobalLocationAccess(actor.role)) {
    await grantLocationAccess(actor.id, warehouse.id);
  }
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-B19-DLV-1", price: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
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

describe("delivery capability-gating — the positive case (Batch 19, closing a Batch 18 gap)", () => {
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

  it("resolves CANCEL_SHIPMENT=true / FETCH_CITIES=false for a provider whose adapter declares exactly that — with no connection test ever run", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const provider = await createShippingProviderAction(formData({ name: "Transporteur de test", type: "API" }));
    if (!provider.ok) throw new Error("setup failed");
    // Configure only — never testDeliveryProviderConnectionAction, so
    // connectionStatus stays CONFIGURE, never CONNECTE.
    const configured = await configureDeliveryProviderApiAction(
      formData({ providerId: provider.data.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
    );
    expect(configured.ok).toBe(true);
    const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id: provider.data.id } });
    expect(row.connectionStatus).toBe("CONFIGURE");

    const caps = providerCapabilities({ type: row.type, providerKey: row.providerKey });
    expect(caps).toContain("CANCEL_SHIPMENT");
    expect(caps).not.toContain("FETCH_CITIES");

    // Same result through the actual UI-facing query.
    const options = await listShipmentProviderOptions();
    const found = options.find((p) => p.id === provider.data.id);
    expect(found?.capabilities).toContain("CANCEL_SHIPMENT");
    expect(found?.connectionStatus).not.toBe("CONNECTE");
  });

  it("the gate isn't cosmetic: a shipment created against this provider can genuinely be cancelled", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const provider = await createShippingProviderAction(formData({ name: "Transporteur de test", type: "API" }));
    if (!provider.ok) throw new Error("setup failed");
    await configureDeliveryProviderApiAction(
      formData({ providerId: provider.data.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
    );
    const orderId = await seedShippableOrder();
    const created = await createShipmentViaProviderAction(formData({ orderId, providerId: provider.data.id }));
    if (!created.ok) throw new Error("setup failed");

    // The exact predicate ShipmentProviderControls' `canCancel` gate uses.
    expect(providerCapabilities({ type: "API", providerKey: REFERENCE_PROVIDER_KEY })).toContain("CANCEL_SHIPMENT");

    const cancelled = await cancelShipmentAction(formData({ shipmentId: created.data.id }));
    expect(cancelled.ok).toBe(true);
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(shipment.status).toBe("ANNULE");
  });
});
