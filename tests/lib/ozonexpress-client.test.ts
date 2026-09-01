import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OzonExpressClient, assertNoApiError, parseMoney } from "@/lib/integrations/delivery/providers/ozonexpress/client";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryNotFoundError,
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
      const c = new OzonExpressClient(creds, "https://169.254.169.254");
      await expect(c.post("tracking", {})).rejects.toBeInstanceOf(DeliveryConfigError);
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
    it("an unclassifiable message maps to a generic DeliveryUnavailableError with a fixed French string", () => {
      expect(() => assertNoApiError({ RESULT: "ERROR", MESSAGE: "weird internal thing 0xDEAD" })).toThrow(
        DeliveryUnavailableError
      );
      try {
        assertNoApiError({ RESULT: "ERROR", MESSAGE: "weird internal thing 0xDEAD" });
      } catch (e) {
        expect((e as Error).message).not.toContain("0xDEAD");
      }
    });
    it("passes through a genuine success body untouched", () => {
      expect(() => assertNoApiError({ "TRACKING-NUMBER": "OZE1", RESULT: "SUCCESS" })).not.toThrow();
    });
  });

  it("bad credentials are surfaced as DeliveryAuthError (fake returns HTTP 200 RESULT:ERROR)", async () => {
    const c = new OzonExpressClient({ customerId: "wrong", apiKey: "wrong" }, FAKE_OZ_BASE_URL);
    await expect(c.post("tracking", { "tracking-number": "OZE1" })).rejects.toBeInstanceOf(DeliveryAuthError);
  });
});
