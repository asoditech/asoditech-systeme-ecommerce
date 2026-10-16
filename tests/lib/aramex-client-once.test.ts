import { afterEach, describe, expect, it, vi } from "vitest";
import { AramexClient } from "@/lib/integrations/delivery/providers/aramex/client";
import { DeliveryOutcomeUnknownError, DeliveryUnavailableError } from "@/lib/integrations/delivery/errors";

/**
 * Aramex shipment creation is ONE attempt (2026-10-16 review, same rule as
 * OzonExpress — docs/adr/0013): anything that may have reached Aramex is an
 * unknown outcome, never an automatic resend that would create a second AWB.
 * Stubbed fetch only; a literal public IP avoids any DNS lookup.
 */

const creds = {
  userName: "fake-user@example.com",
  password: "fake-password",
  accountNumber: "000000",
  accountPin: "000000",
  accountEntity: "CMN",
  accountCountryCode: "MA",
};
const BASE = "https://93.184.216.34/shipping";
const client = () => new AramexClient(creds, { timeoutMs: 1000, shippingBaseUrl: BASE, trackingBaseUrl: BASE, rateBaseUrl: BASE });
const create = () => client().post("shipping", "Service_1_0.svc/json/CreateShipments", { Shipments: [] }, { once: true });
const stub = (impl: () => Promise<Response>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => vi.unstubAllGlobals());

describe("AramexClient.post({ once: true }) — shipment creation", () => {
  it("a 5xx is an unknown outcome, sent exactly once", async () => {
    const fetchFn = stub(async () => new Response("", { status: 503 }));
    await expect(create()).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a 429 is an unknown outcome, sent exactly once", async () => {
    const fetchFn = stub(async () => new Response("", { status: 429 }));
    await expect(create()).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a connection reset after sending is an unknown outcome; a never-established connection is a definite failure", async () => {
    stub(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    });
    await expect(create()).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    const refused = stub(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    await expect(create()).rejects.toBeInstanceOf(DeliveryUnavailableError);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("an unreadable 2xx is an unknown outcome", async () => {
    stub(async () => new Response("not json", { status: 200 }));
    await expect(create()).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
  });

  it("reads (tracking) still retry a 5xx", async () => {
    let calls = 0;
    stub(async () => {
      calls += 1;
      return calls < 2 ? new Response("", { status: 503 }) : new Response(JSON.stringify({ HasErrors: false }), { status: 200 });
    });
    await expect(client().post("tracking", "Service_1_0.svc/json/TrackShipments", {})).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });
});
