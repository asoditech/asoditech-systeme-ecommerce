import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import {
  buildDeliveryNoteDocuments,
  parseDeliveryNoteRef,
} from "@/lib/integrations/delivery/providers/ozonexpress/mapper";
import { ozonExpressAdapter } from "@/lib/integrations/delivery/providers/ozonexpress";
import {
  generateManifestViaProvider,
  ManifestSelectionError,
} from "@/lib/integrations/delivery/service";
import { referenceDeliveryProvider, REFERENCE_PROVIDER_KEY } from "../helpers/reference-delivery-provider";
import { assertCapability } from "@/lib/integrations/delivery/registry";
import {
  DeliveryMalformedResponseError,
  DeliveryProviderError,
  DeliveryUnsupportedCapabilityError,
} from "@/lib/integrations/delivery/errors";
import {
  installFakeOzonExpress,
  emptyFakeOzonExpressState,
  FAKE_OZ_API_KEY,
  FAKE_OZ_CUSTOMER_ID,
  FAKE_OZ_BASE_URL,
  type FakeOzonExpressState,
} from "../helpers/fake-ozonexpress";
import {
  installFakeReferenceCarrier,
  emptyFakeCarrierState,
  FAKE_API_KEY,
  type FakeCarrierState,
} from "../helpers/fake-reference-carrier";
import { resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import {
  registerDeliveryProvider,
  __resetDeliveryProviderRegistryForTests,
} from "@/lib/integrations/delivery/registry";

const ozCredentials = { customerId: FAKE_OZ_CUSTOMER_ID, apiKey: FAKE_OZ_API_KEY };
const ozConfig = { baseUrl: FAKE_OZ_BASE_URL, requestTimeoutMs: 1000 };

// ───────────────────────────────────────────────────────────────────────
// mapper — parseDeliveryNoteRef / buildDeliveryNoteDocuments (pure)
// ───────────────────────────────────────────────────────────────────────
describe("OzonExpress delivery-note mapper", () => {
  it("reads a flat `ref`", () => {
    expect(parseDeliveryNoteRef({ ref: "BL240115001" })).toBe("BL240115001");
  });

  it("reads capitalised and nested ref variants", () => {
    expect(parseDeliveryNoteRef({ REF: "BL-2" })).toBe("BL-2");
    expect(parseDeliveryNoteRef({ "DELIVERY-NOTE": { ref: "BL-3" } })).toBe("BL-3");
    expect(parseDeliveryNoteRef({ "ADD-DELIVERY-NOTE": { REF: 4 } })).toBe("4");
  });

  it("throws — never fabricates — when no ref is present", () => {
    expect(() => parseDeliveryNoteRef({ RESULT: "SUCCESS" })).toThrow(DeliveryMalformedResponseError);
    expect(() => parseDeliveryNoteRef({ ref: "   " })).toThrow(DeliveryMalformedResponseError);
    expect(() => parseDeliveryNoteRef("nonsense")).toThrow(DeliveryMalformedResponseError);
  });

  it("builds the three documented portal PDF URLs, ref-encoded", () => {
    const docs = buildDeliveryNoteDocuments("BL 12/3", {});
    expect(docs).toHaveLength(3);
    expect(docs[0]).toEqual({
      label: "Bordereau (BL)",
      url: "https://client.ozoneexpress.ma/pdf-delivery-note?dn-ref=BL%2012%2F3",
    });
    expect(docs.map((d) => d.label)).toEqual(["Bordereau (BL)", "Étiquettes A4", "Étiquettes 10×10 cm"]);
    for (const d of docs) expect(new URL(d.url).protocol).toBe("https:");
  });

  it("honours a config portalBaseUrl override", () => {
    const docs = buildDeliveryNoteDocuments("BL9", { portalBaseUrl: "https://portal.example.com/" });
    expect(docs[0].url).toBe("https://portal.example.com/pdf-delivery-note?dn-ref=BL9");
  });
});

// ───────────────────────────────────────────────────────────────────────
// adapter — generateManifest against the fake OzonExpress HTTP API
// ───────────────────────────────────────────────────────────────────────
describe("OzonExpress adapter.generateManifest (fake HTTP)", () => {
  let state: FakeOzonExpressState;

  beforeEach(() => {
    state = emptyFakeOzonExpressState();
    installFakeOzonExpress(state);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("declares GENERATE_MANIFEST and runs the 4-step flow", async () => {
    expect(() => assertCapability(ozonExpressAdapter, "GENERATE_MANIFEST")).not.toThrow();

    const result = await ozExpressGenerate(["OZE111", "OZE222"]);

    expect(result.externalRef).toMatch(/^BL/);
    expect(result.parcelCount).toBeNull(); // never inferred from input length
    expect(result.documents.map((d) => d.label)).toEqual([
      "Bordereau (BL)",
      "Étiquettes A4",
      "Étiquettes 10×10 cm",
    ]);
    // step 2 received every tracking number as Codes[i]
    expect(state.seenManifestCodes).toEqual(["OZE111", "OZE222"]);
    // the api key only ever appears in the credentialed path, never a query string
    for (const url of state.seenUrls) {
      expect(url).not.toContain("?");
      if (url.includes(FAKE_OZ_API_KEY)) expect(url).toContain(`/${FAKE_OZ_API_KEY}/`);
    }
  });

  it("nested ref envelope is tolerated", async () => {
    state.deliveryNoteNestRef = true;
    const result = await ozExpressGenerate(["OZE1"]);
    expect(result.externalRef).toMatch(/^BL/);
  });

  it("propagates a carrier RESULT:ERROR at any step as a typed error", async () => {
    for (const step of ["add-delivery-note", "add-parcel-to-delivery-note", "save-delivery-note"] as const) {
      const s = emptyFakeOzonExpressState();
      s.deliveryNoteFailStep = step;
      s.deliveryNoteStepErrorMessage = "boom";
      installFakeOzonExpress(s);
      await expect(ozExpressGenerate(["OZE1"])).rejects.toBeInstanceOf(DeliveryProviderError);
      vi.unstubAllGlobals();
    }
  });

  it("a create response with no ref is a malformed response, not a fabricated ref", async () => {
    state.deliveryNoteOmitRef = true;
    await expect(ozExpressGenerate(["OZE1"])).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
  });

  async function ozExpressGenerate(externalIds: string[]) {
    return ozonExpressAdapter.generateManifest!({ externalIds }, ozCredentials, ozConfig);
  }
});

// ───────────────────────────────────────────────────────────────────────
// registry — assertCapability rejects a provider without GENERATE_MANIFEST
// ───────────────────────────────────────────────────────────────────────
describe("GENERATE_MANIFEST capability gating", () => {
  it("throws the typed unsupported error for an adapter that omits it", () => {
    const noManifest = { ...referenceDeliveryProvider, capabilities: ["CREATE_SHIPMENT"] as const };
    expect(() => assertCapability(noManifest, "GENERATE_MANIFEST")).toThrow(
      DeliveryUnsupportedCapabilityError
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// service — generateManifestViaProvider against the real test DB
// (reference fixture adapter — same convention as delivery-service.test.ts)
// ───────────────────────────────────────────────────────────────────────
describe("generateManifestViaProvider (reference adapter, real DB)", () => {
  let carrierState: FakeCarrierState;
  let userId: string;

  beforeEach(async () => {
    await resetDb();
    __resetDeliveryProviderRegistryForTests();
    registerDeliveryProvider(referenceDeliveryProvider);
    carrierState = emptyFakeCarrierState();
    installFakeReferenceCarrier(carrierState);
    userId = (await createTestUser({ role: "MANAGER" })).id;
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await resetDb();
  });

  async function seedProvider() {
    return prisma.shippingProvider.create({
      data: {
        name: "Transporteur de référence",
        type: "API",
        providerKey: REFERENCE_PROVIDER_KEY,
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_API_KEY })),
        connectionStatus: "CONNECTE",
      },
    });
  }

  async function seedShipment(
    providerId: string,
    overrides: Partial<{ status: "EN_ATTENTE" | "EN_TRANSIT"; externalId: string | null; manifestId: string | null }> = {}
  ) {
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, status: "CONFIRMEE", subtotal: 100, total: 100 },
    });
    return prisma.shipment.create({
      data: {
        orderId: order.id,
        providerId,
        status: overrides.status ?? "EN_ATTENTE",
        externalId: overrides.externalId === undefined ? `EXT-${order.id}` : overrides.externalId,
        manifestId: overrides.manifestId ?? null,
        updatedById: userId,
      },
    });
  }

  it("creates a FINALISE manifest and links every selected shipment", async () => {
    const provider = await seedProvider();
    const s1 = await seedShipment(provider.id);
    const s2 = await seedShipment(provider.id);

    const manifest = await generateManifestViaProvider({
      providerId: provider.id,
      shipmentIds: [s1.id, s2.id],
      createdById: userId,
    });

    expect(manifest.status).toBe("FINALISE");
    expect(manifest.externalRef).toMatch(/^MREF-/);
    expect(manifest.parcelCount).toBe(2); // fake reports parcel_count = codes.length
    const docs = manifest.documents as { label: string; url: string }[];
    expect(docs[0].url).toMatch(/^https:\/\//);

    const linked = await prisma.shipment.findMany({ where: { manifestId: manifest.id } });
    expect(linked.map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    // the carrier received our external ids
    expect(carrierState.lastManifestCodes?.sort()).toEqual([s1.externalId, s2.externalId].sort());
  });

  it("rejects the selection (no local row) when shipments span providers", async () => {
    const p1 = await seedProvider();
    const p2 = await prisma.shippingProvider.create({
      data: {
        name: "Autre",
        type: "API",
        providerKey: REFERENCE_PROVIDER_KEY,
        credentialsEncrypted: encryptSecret(JSON.stringify({ apiKey: FAKE_API_KEY })),
        connectionStatus: "CONNECTE",
      },
    });
    const s1 = await seedShipment(p1.id);
    const s2 = await seedShipment(p2.id);

    await expect(
      generateManifestViaProvider({ providerId: p1.id, shipmentIds: [s1.id, s2.id], createdById: userId })
    ).rejects.toBeInstanceOf(ManifestSelectionError);
    expect(await prisma.deliveryManifest.count()).toBe(0);
  });

  it("rejects a manually-created shipment (no externalId)", async () => {
    const provider = await seedProvider();
    const manual = await seedShipment(provider.id, { externalId: null });
    await expect(
      generateManifestViaProvider({ providerId: provider.id, shipmentIds: [manual.id], createdById: userId })
    ).rejects.toBeInstanceOf(ManifestSelectionError);
  });

  it("rejects a shipment already on a manifest", async () => {
    const provider = await seedProvider();
    const first = await seedShipment(provider.id);
    const m = await generateManifestViaProvider({
      providerId: provider.id,
      shipmentIds: [first.id],
      createdById: userId,
    });
    // second attempt with the same shipment
    await expect(
      generateManifestViaProvider({ providerId: provider.id, shipmentIds: [first.id], createdById: userId })
    ).rejects.toBeInstanceOf(ManifestSelectionError);
    expect(m.status).toBe("FINALISE");
  });

  it("rejects a shipment no longer EN_ATTENTE", async () => {
    const provider = await seedProvider();
    const moving = await seedShipment(provider.id, { status: "EN_TRANSIT" });
    await expect(
      generateManifestViaProvider({ providerId: provider.id, shipmentIds: [moving.id], createdById: userId })
    ).rejects.toBeInstanceOf(ManifestSelectionError);
  });

  it("marks the manifest ECHEC and links nothing when the carrier fails", async () => {
    const provider = await seedProvider();
    const s1 = await seedShipment(provider.id);
    carrierState.forceManifestStatus = 500;

    await expect(
      generateManifestViaProvider({ providerId: provider.id, shipmentIds: [s1.id], createdById: userId })
    ).rejects.toBeInstanceOf(DeliveryProviderError);

    const manifest = await prisma.deliveryManifest.findFirstOrThrow();
    expect(manifest.status).toBe("ECHEC");
    expect(manifest.failedReason).toBeTruthy();
    expect(await prisma.shipment.count({ where: { manifestId: { not: null } } })).toBe(0);
  });

  it("marks ECHEC on a carrier response with no ref", async () => {
    const provider = await seedProvider();
    const s1 = await seedShipment(provider.id);
    carrierState.manifestOmitRef = true;
    await expect(
      generateManifestViaProvider({ providerId: provider.id, shipmentIds: [s1.id], createdById: userId })
    ).rejects.toBeInstanceOf(DeliveryProviderError);
    const manifest = await prisma.deliveryManifest.findFirstOrThrow();
    expect(manifest.status).toBe("ECHEC");
  });
});
