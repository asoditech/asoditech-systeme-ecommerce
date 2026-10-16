import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OzonExpressClient, assertNoApiError, parseMoney } from "@/lib/integrations/delivery/providers/ozonexpress/client";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryNotFoundError,
  DeliveryOutcomeUnknownError,
  DeliveryProviderError,
  DeliveryRateLimitError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import {
  installFakeOzonExpress,
  emptyFakeOzonExpressState,
  FAKE_OZ_API_KEY,
  FAKE_OZ_CUSTOMER_ID,
  FAKE_OZ_BASE_URL,
  type FakeOzonExpressState,
} from "../helpers/fake-ozonexpress";

const creds = { customerId: FAKE_OZ_CUSTOMER_ID, apiKey: FAKE_OZ_API_KEY };
let state: FakeOzonExpressState;

function client() {
  return new OzonExpressClient(creds, FAKE_OZ_BASE_URL, { timeoutMs: 1000 });
}

describe("OzonExpressClient", () => {
  beforeEach(() => {
    state = emptyFakeOzonExpressState();
    installFakeOzonExpress(state);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("parseMoney — never coerces missing to 0", () => {
    it.each([
      [null, null],
      [undefined, null],
      ["", null],
      ["  ", null],
      ["abc", null],
      ["25.00", 25],
      [30, 30],
      ["0", 0],
    ])("parseMoney(%j) === %j", (input, expected) => {
      expect(parseMoney(input)).toBe(expected);
    });
  });

  describe("path-based auth and credential safety", () => {
    it("puts customer id and api key in the URL path, never a query string or header", async () => {
      await client().post("add-parcel", { "parcel-receiver": "A" });
      const url = state.seenUrls[0];
      expect(url).toContain(`/customers/${FAKE_OZ_CUSTOMER_ID}/${FAKE_OZ_API_KEY}/add-parcel`);
      expect(new URL(url).search).toBe("");
    });

    it("never leaks the request URL (which embeds the api key) into a thrown error", async () => {
      state.forceHttpStatus = 500;
      let err: Error | undefined;
      try {
        await client().post("tracking", { "tracking-number": "OZE1" });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(DeliveryProviderError);
      expect(err?.message).not.toContain(FAKE_OZ_API_KEY);
      expect(err?.message).not.toContain("http");
    });

    it("url-encodes credential path segments", () => {
      const c = new OzonExpressClient({ customerId: "a/b c", apiKey: "k?e=y" }, FAKE_OZ_BASE_URL);
      // @ts-expect-error — private, inspected only to prove encoding
      expect(c.pathPrefix).toBe("/customers/a%2Fb%20c/k%3Fe%3Dy");
    });
  });

  describe("SSRF", () => {
    it("rejects a base URL resolving to a private/reserved address before any request", async () => {
      // Refused at construction now (not an official OzonExpress host —
      // 2026-10-16 allowlist); assertPublicHost still runs per request.
      expect(() => new OzonExpressClient(creds, "https://169.254.169.254")).toThrow(DeliveryConfigError);
    });

    it("rejects a non-HTTPS base URL at construction", () => {
      expect(() => new OzonExpressClient(creds, "http://api.ozonexpress.ma")).toThrow(DeliveryConfigError);
    });
  });

  describe("HTTP error mapping", () => {
    it("401/403 -> DeliveryAuthError", async () => {
      state.forceHttpStatus = 403;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryAuthError);
    });
    it("404 -> DeliveryNotFoundError", async () => {
      state.forceHttpStatus = 404;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryNotFoundError);
    });
    it("429 -> DeliveryRateLimitError after retries", async () => {
      state.forceHttpStatus = 429;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryRateLimitError);
    });
    it("5xx -> DeliveryUnavailableError after retries", async () => {
      state.forceHttpStatus = 503;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryUnavailableError);
    });
    it("non-JSON body -> DeliveryMalformedResponseError", async () => {
      state.malformedBody = true;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
    });
    it("a hanging request times out cleanly instead of hanging forever", async () => {
      state.hang = true;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryTimeoutError);
    }, 8000);
  });

  describe("one-shot requests ({ once: true } — parcel creation): never retried", () => {
    const calls = () => state.seenUrls.filter((u) => u.includes("/add-parcel")).length;

    it("a timeout -> DeliveryOutcomeUnknownError after exactly one attempt", async () => {
      state.hang = true;
      await expect(client().post("add-parcel", {}, { once: true })).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(calls()).toBe(1);
    }, 8000);

    it("a 5xx -> DeliveryOutcomeUnknownError after exactly one attempt", async () => {
      state.forceHttpStatus = 503;
      await expect(client().post("add-parcel", {}, { once: true })).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(calls()).toBe(1);
    });

    it("a 429 -> DeliveryOutcomeUnknownError after exactly one attempt (OzonExpress documents no rate limiting: no evidence a 429 means « not executed »)", async () => {
      state.forceHttpStatus = 429;
      await expect(client().post("add-parcel", {}, { once: true })).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(calls()).toBe(1);
    });

    it("read requests (default) keep the 429 behaviour: retried, then DeliveryRateLimitError", async () => {
      state.forceHttpStatus = 429;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryRateLimitError);
      expect(state.seenUrls.filter((u) => u.includes("/tracking")).length).toBe(3);
    });

    it("a connection lost mid-request (ECONNRESET) -> DeliveryOutcomeUnknownError, one attempt", async () => {
      state.networkErrorCode = "ECONNRESET";
      await expect(client().post("add-parcel", {}, { once: true })).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(calls()).toBe(1);
    });

    it("a connection never established (ECONNREFUSED / ENOTFOUND) is a definite failure, one attempt", async () => {
      for (const code of ["ECONNREFUSED", "ENOTFOUND"]) {
        state.seenUrls = [];
        state.networkErrorCode = code;
        const error = await client().post("add-parcel", {}, { once: true }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DeliveryUnavailableError);
        expect(error).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
        expect(calls()).toBe(1);
      }
    });

    it("an unreadable 2xx body -> DeliveryOutcomeUnknownError", async () => {
      state.malformedBody = true;
      await expect(client().post("add-parcel", {}, { once: true })).rejects.toBeInstanceOf(DeliveryOutcomeUnknownError);
    });

    it("an HTTP-200 RESULT:ERROR stays a definite, classified error", async () => {
      state.forcePathErrorMessage = "City Not Found";
      const error = await client().post("add-parcel", {}, { once: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DeliveryProviderError);
      expect(error).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
    });

    it("the outcome-unknown error never carries the credential-bearing URL", async () => {
      state.forceHttpStatus = 502;
      const error = (await client().post("add-parcel", {}, { once: true }).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain(FAKE_OZ_API_KEY);
      expect(error.message).not.toContain(FAKE_OZ_CUSTOMER_ID);
      expect(error.message).not.toContain("example.com");
    });

    it("read requests (default) still retry: a 5xx on `tracking` is attempted 3 times", async () => {
      state.forceHttpStatus = 503;
      await expect(client().post("tracking", {})).rejects.toBeInstanceOf(DeliveryUnavailableError);
      expect(state.seenUrls.filter((u) => u.includes("/tracking")).length).toBe(3);
    });
  });

  describe("HTTP-200-with-RESULT:ERROR unwrapping (assertNoApiError)", () => {
    it("classifies a top-level RESULT:ERROR body", async () => {
      state.forceAddParcelErrorMessage = "City Not Found";
      await expect(client().post("add-parcel", {})).rejects.toBeInstanceOf(DeliveryConfigError);
    });
    it("classifies an error nested under an action key", async () => {
      state.forceAddParcelErrorMessage = "Invalid API Key";
      state.nestErrorEnvelope = true;
      await expect(client().post("add-parcel", {})).rejects.toBeInstanceOf(DeliveryAuthError);
    });
    it("a 'Parcel not found' message maps to DeliveryNotFoundError", () => {
      expect(() => assertNoApiError({ RESULT: "ERROR", MESSAGE: "Parcel not found" })).toThrow(DeliveryNotFoundError);
    });
    it("an unclassifiable message surfaces OzonExpress's own wording (the operator's diagnostic)", () => {
      let err: Error | undefined;
      try {
        assertNoApiError({ RESULT: "ERROR", MESSAGE: "Compte marchand non activé" });
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeInstanceOf(DeliveryUnavailableError);
      expect(err?.message).toContain("Compte marchand non activé");
    });

    it("redacts this client's credential values and long tokens from a surfaced message", () => {
      let err: Error | undefined;
      try {
        assertNoApiError(
          { RESULT: "ERROR", MESSAGE: `Clé ${FAKE_OZ_API_KEY} invalide (ref ABCDEFGHIJ0123456789KLMNOP)` },
          (s) => s.split(FAKE_OZ_API_KEY).join("«masqué»")
        );
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).not.toContain(FAKE_OZ_API_KEY);
      expect(err?.message).not.toContain("ABCDEFGHIJ0123456789KLMNOP");
      expect(err?.message).toContain("«masqué»");
    });
    it("passes through a genuine success body untouched", () => {
      expect(() => assertNoApiError({ "TRACKING-NUMBER": "OZE1", RESULT: "SUCCESS" })).not.toThrow();
    });
  });

  it("bad credentials are surfaced as DeliveryAuthError (fake returns HTTP 200 RESULT:ERROR)", async () => {
    const c = new OzonExpressClient({ customerId: "wrong", apiKey: "wrong" }, FAKE_OZ_BASE_URL);
    await expect(c.post("tracking", { "tracking-number": "OZE1" })).rejects.toBeInstanceOf(DeliveryAuthError);
  });

  describe("get() — the un-credentialed GET /cities catalogue", () => {
    it("hits <host>/<path> with NO customer/key path segments", async () => {
      await client().get("cities");
      const url = state.seenUrls[0];
      expect(new URL(url).pathname).toBe("/cities");
      expect(url).not.toContain(FAKE_OZ_CUSTOMER_ID);
      expect(url).not.toContain(FAKE_OZ_API_KEY);
    });

    it("returns the parsed JSON body (real shape: CITIES keyed by id)", async () => {
      const body = (await client().get("cities")) as { CITIES: Record<string, unknown> };
      expect(Object.keys(body.CITIES).length).toBeGreaterThan(0);
    });

    it("maps a 5xx to DeliveryUnavailableError", async () => {
      state.forceCitiesHttpStatus = 502;
      await expect(client().get("cities")).rejects.toBeInstanceOf(DeliveryUnavailableError);
    });

    it("maps non-JSON to DeliveryMalformedResponseError", async () => {
      state.malformedBody = true;
      await expect(client().get("cities")).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
    });

    it("re-checks SSRF — a private-IP host is rejected", async () => {
      expect(() => new OzonExpressClient(creds, "https://10.0.0.1", { timeoutMs: 1000 })).toThrow(DeliveryConfigError);
    });
  });
});
