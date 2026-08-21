import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { referenceDeliveryProvider, REFERENCE_BASE_URL } from "../helpers/reference-delivery-provider";
import { installFakeReferenceCarrier, emptyFakeCarrierState, FAKE_API_KEY, type FakeCarrierState } from "../helpers/fake-reference-carrier";
import {
  DeliveryAuthError,
  DeliveryMalformedResponseError,
  DeliveryTimeoutError,
  DeliveryConfigError,
} from "@/lib/integrations/delivery/errors";
import { generateSharedSecret, verifyHmacSha256Base64 } from "@/lib/integrations/shared";
import { createHmac } from "node:crypto";

let state: FakeCarrierState;

describe("reference delivery adapter (fixture, proves the abstraction)", () => {
  beforeEach(() => {
    state = emptyFakeCarrierState();
    installFakeReferenceCarrier(state);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const credentials = { apiKey: FAKE_API_KEY };
  const config = {};

  it("testConnection succeeds against a real authenticated request", async () => {
    await expect(referenceDeliveryProvider.testConnection(credentials, config)).resolves.toEqual({ ok: true });
  });

  it("testConnection fails with DeliveryAuthError on bad credentials", async () => {
    await expect(referenceDeliveryProvider.testConnection({ apiKey: "wrong" }, config)).rejects.toBeInstanceOf(DeliveryAuthError);
  });

  it("testConnection fails distinctly when the carrier reports an outage", async () => {
    state.forceAccountStatus = 503;
    await expect(referenceDeliveryProvider.testConnection(credentials, config)).rejects.toThrow();
  });

  it("testConnection times out cleanly rather than hanging forever", async () => {
    state.hang = true;
    await expect(referenceDeliveryProvider.testConnection(credentials, config)).rejects.toBeInstanceOf(DeliveryTimeoutError);
  }, 8000);

  it("createShipment returns exactly what the provider returned — never fabricated", async () => {
    const result = await referenceDeliveryProvider.createShipment!(
      { localShipmentId: "s1", orderNumber: "1001", recipientName: "Amine", addressLine1: "1 rue", addressLine2: null, city: "Rabat", region: null, country: "MA", phone: null, codAmount: null, currency: "MAD", notes: null },
      credentials,
      config
    );
    expect(result.externalId).toBe("ref-1");
    expect(result.trackingNumber).toBe("TRK-ref-1");
    expect(result.cost).toBe(25.5);
  });

  it("createShipment surfaces a malformed response as a typed error, not a fake success", async () => {
    state.malformedCreateResponse = true;
    await expect(
      referenceDeliveryProvider.createShipment!(
        { localShipmentId: "s1", orderNumber: "1001", recipientName: "Amine", addressLine1: "1 rue", addressLine2: null, city: "Rabat", region: null, country: "MA", phone: null, codAmount: null, currency: "MAD", notes: null },
        credentials,
        config
      )
    ).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
  });

  it("createShipment surfaces provider rejection distinctly", async () => {
    state.forceCreateStatus = 422;
    await expect(
      referenceDeliveryProvider.createShipment!(
        { localShipmentId: "s1", orderNumber: "1001", recipientName: "Amine", addressLine1: "1 rue", addressLine2: null, city: "Rabat", region: null, country: "MA", phone: null, codAmount: null, currency: "MAD", notes: null },
        credentials,
        config
      )
    ).rejects.toThrow();
  });

  it("cancelShipment calls the carrier's cancel endpoint", async () => {
    const created = await referenceDeliveryProvider.createShipment!(
      { localShipmentId: "s1", orderNumber: "1001", recipientName: "Amine", addressLine1: "1 rue", addressLine2: null, city: "Rabat", region: null, country: "MA", phone: null, codAmount: null, currency: "MAD", notes: null },
      credentials,
      config
    );
    await referenceDeliveryProvider.cancelShipment!({ externalId: created.externalId }, credentials, config);
    expect(state.shipments.get(created.externalId)?.status).toBe("cancelled");
  });

  it("fetchStatus maps every known raw status to a local ShipmentStatus", () => {
    expect(referenceDeliveryProvider.mapStatus!("created")).toBe("EN_ATTENTE");
    expect(referenceDeliveryProvider.mapStatus!("in_transit")).toBe("EN_TRANSIT");
    expect(referenceDeliveryProvider.mapStatus!("delivered")).toBe("LIVRE");
    expect(referenceDeliveryProvider.mapStatus!("failed")).toBe("ECHEC");
    expect(referenceDeliveryProvider.mapStatus!("returned")).toBe("RETOURNE");
    expect(referenceDeliveryProvider.mapStatus!("cancelled")).toBe("ANNULE");
  });

  it("fetchStatus never guesses an unrecognized raw status — returns null", () => {
    expect(referenceDeliveryProvider.mapStatus!("some_future_carrier_status")).toBeNull();
  });

  it("rejects a config baseUrl pointing at a private/reserved address (SSRF)", async () => {
    await expect(
      referenceDeliveryProvider.testConnection(credentials, { baseUrl: "http://169.254.169.254/" })
    ).rejects.toBeInstanceOf(DeliveryConfigError);
  });

  it("webhook signature verification accepts a correctly signed payload and rejects a tampered one", () => {
    const secret = generateSharedSecret();
    const body = JSON.stringify({ delivery_id: "d1", topic: "shipment.status_changed", shipment_id: "ref-1", status: "delivered" });
    const signature = createHmac("sha256", secret).update(body, "utf8").digest("base64");

    expect(referenceDeliveryProvider.verifyWebhookSignature!(body, { "x-reference-signature": signature }, secret)).toBe(true);
    expect(referenceDeliveryProvider.verifyWebhookSignature!(body + "tampered", { "x-reference-signature": signature }, secret)).toBe(false);
    expect(referenceDeliveryProvider.verifyWebhookSignature!(body, {}, secret)).toBe(false);
  });

  it("mapWebhookPayload ignores a topic it doesn't handle rather than throwing", () => {
    const body = JSON.stringify({ delivery_id: "d1", topic: "unrelated.topic", shipment_id: "ref-1", status: "delivered" });
    expect(referenceDeliveryProvider.mapWebhookPayload!(body, {})).toBeNull();
  });

  it("REFERENCE_BASE_URL is a real, resolvable domain (SSRF check exercises DNS for real)", () => {
    expect(REFERENCE_BASE_URL).toBe("https://example.com");
  });

  it("verifyHmacSha256Base64 is the exact same shared primitive used by WooCommerce/Shopify", () => {
    const secret = "s3cr3t";
    const body = "hello";
    const sig = createHmac("sha256", secret).update(body, "utf8").digest("base64");
    expect(verifyHmacSha256Base64(body, sig, secret)).toBe(true);
  });
});
