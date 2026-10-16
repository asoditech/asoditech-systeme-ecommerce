import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real DNS either: assertPublicHost's lookup is stubbed (default: a
// public IP). Individual tests swap it to prove the SSRF re-check.
const dns = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts?: unknown) => Promise<{ address: string; family: number }[]>>(async () => [
    { address: "93.184.216.34", family: 4 },
  ]),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

import { AmeexClient, AmeexRateLimiter } from "@/lib/integrations/delivery/providers/ameex/client";
import { AMEEX_BASE_URL } from "@/lib/integrations/delivery/providers/ameex/types";
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
  emptyFakeAmeexState,
  FAKE_AMEEX_API_ID,
  FAKE_AMEEX_LIVE_KEY,
  installFakeAmeex,
  type FakeAmeexState,
} from "../helpers/fake-ameex";

const creds = { apiId: FAKE_AMEEX_API_ID, apiKey: FAKE_AMEEX_LIVE_KEY };
let state: FakeAmeexState;
let fetchMock: ReturnType<typeof installFakeAmeex>;

function client(opts: { timeoutMs?: number; limiter?: AmeexRateLimiter; baseUrl?: string } = {}) {
  return new AmeexClient(creds, {
    timeoutMs: opts.timeoutMs ?? 1000,
    rateLimiter: opts.limiter ?? new AmeexRateLimiter(),
    sleep: async () => {},
    baseUrl: opts.baseUrl,
  });
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

function expectNoSecretLeak(err: Error) {
  const dump = `${err.message} ${String(err.stack)} ${JSON.stringify(err)} ${String((err as { cause?: unknown }).cause ?? "")}`;
  expect(dump).not.toContain(FAKE_AMEEX_LIVE_KEY);
  expect(dump).not.toContain("api.ameex.app");
}

describe("AmeexClient", () => {
  beforeEach(() => {
    state = emptyFakeAmeexState();
    fetchMock = installFakeAmeex(state);
    dns.lookup.mockClear();
    dns.lookup.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("auth headers and request hygiene", () => {
    it("sends C-Api-Id / C-Api-Key headers to the fixed https base, key never in the URL", async () => {
      await client().get("/Delivery/Parcels/Statuts");
      expect(state.requests).toHaveLength(1);
      const req = state.requests[0];
      expect(req.method).toBe("GET");
      expect(req.url).toBe(`${AMEEX_BASE_URL}/Delivery/Parcels/Statuts`);
      expect(req.url.startsWith("https://api.ameex.app/customer/")).toBe(true);
      expect(req.headers["c-api-id"]).toBe(FAKE_AMEEX_API_ID);
      expect(req.headers["c-api-key"]).toBe(FAKE_AMEEX_LIVE_KEY);
      expect(req.url).not.toContain(FAKE_AMEEX_LIVE_KEY);
    });

    it("uses redirect:error and an abort signal", async () => {
      await client().get("/Delivery/Cities");
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("returns the parsed JSON body untouched (shape not assumed)", async () => {
      state.successBody = { anything: [1, 2] };
      await expect(client().get("/Delivery/Cities")).resolves.toEqual({ anything: [1, 2] });
    });
  });

  describe("credential safety", () => {
    it.each([401, 403, 404, 429, 500, 503, 400, 418])("HTTP %i error never carries the key or the URL", async (status) => {
      state.fault = { kind: "status", status };
      const err = await caught(client().get("/Delivery/Parcels/Statuts"));
      expect(err).toBeInstanceOf(DeliveryProviderError);
      expectNoSecretLeak(err);
    });

    it("postOnce errors never carry the key either", async () => {
      for (const fault of [
        { kind: "status", status: 500 },
        { kind: "network", code: "ECONNRESET" },
        { kind: "network", code: "ECONNREFUSED" },
        { kind: "malformed" },
        { kind: "status", status: 401 },
      ] as const) {
        state.fault = fault;
        const err = await caught(client().postOnce("/Delivery/Parcels/Action/Type/Add", { type: "SIMPLE" }, "json"));
        expect(err).toBeInstanceOf(DeliveryProviderError);
        expectNoSecretLeak(err);
      }
    });
  });

  describe("https + SSRF", () => {
    it("rejects a non-https base URL at construction", () => {
      expect(() => client({ baseUrl: "http://api.ameex.app/customer" })).toThrow(DeliveryConfigError);
    });

    it("rejects a private-IP literal base before any request", async () => {
      await expect(client({ baseUrl: "https://169.254.169.254/customer" }).get("/x")).rejects.toBeInstanceOf(
        DeliveryConfigError
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("re-checks DNS before every call — a host now resolving to a private IP is refused (rebinding)", async () => {
      const c = client();
      await c.get("/Delivery/Cities");
      dns.lookup.mockImplementation(async () => [{ address: "10.0.0.5", family: 4 }]);
      await expect(c.get("/Delivery/Cities")).rejects.toBeInstanceOf(DeliveryConfigError);
      await expect(c.postOnce("/Delivery/Parcels/Action/Type/Add", { type: "SIMPLE" }, "form")).rejects.toBeInstanceOf(
        DeliveryConfigError
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(dns.lookup).toHaveBeenCalledTimes(3);
      expect(dns.lookup.mock.calls[0][0]).toBe("api.ameex.app");
    });
  });

  describe("get() — reads", () => {
    it("a hanging request times out (DeliveryTimeoutError), no retry", async () => {
      state.fault = { kind: "hang" };
      await expect(client({ timeoutMs: 50 }).get("/x")).rejects.toBeInstanceOf(DeliveryTimeoutError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries 5xx: 3 attempts then DeliveryUnavailableError", async () => {
      state.fault = { kind: "status", status: 502 };
      await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries 429: 3 attempts then DeliveryRateLimitError", async () => {
      state.fault = { kind: "status", status: 429 };
      await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries network failures: 3 attempts then DeliveryUnavailableError", async () => {
      state.fault = { kind: "network", code: "ECONNRESET" };
      await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("recovers when a retry succeeds", async () => {
      state.sequence = [{ kind: "status", status: 503 }, { kind: "network", code: "ECONNRESET" }, null];
      await expect(client().get("/x")).resolves.toEqual(state.successBody);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("401/403 → DeliveryAuthError, not retried", async () => {
      for (const status of [401, 403]) {
        fetchMock.mockClear();
        state.fault = { kind: "status", status };
        await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryAuthError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    });

    it("404 → DeliveryNotFoundError; 400 → DeliveryConfigError", async () => {
      state.fault = { kind: "status", status: 404 };
      await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryNotFoundError);
      state.fault = { kind: "status", status: 400 };
      await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryConfigError);
    });

    it("non-JSON 2xx → DeliveryMalformedResponseError", async () => {
      state.fault = { kind: "malformed" };
      await expect(client().get("/x")).rejects.toBeInstanceOf(DeliveryMalformedResponseError);
    });
  });

  describe("postOnce() — never retried, uncertain outcomes are flagged", () => {
    const path = "/Delivery/Parcels/Action/Type/Add";
    const body = { type: "SIMPLE", receiver: "Test Fake", phone: "0600000000", city: 1, cod: 100 };

    it.each([
      ["timeout", { kind: "hang" } as const],
      ["connection reset", { kind: "network", code: "ECONNRESET" } as const],
      ["HTTP 500", { kind: "status", status: 500 } as const],
      ["HTTP 503", { kind: "status", status: 503 } as const],
      ["HTTP 429", { kind: "status", status: 429 } as const],
      ["unreadable 2xx", { kind: "malformed" } as const],
    ])("%s → DeliveryOutcomeUnknownError after exactly one attempt", async (_label, fault) => {
      state.fault = fault;
      await expect(client({ timeoutMs: 50 }).postOnce(path, body, "json")).rejects.toBeInstanceOf(
        DeliveryOutcomeUnknownError
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"])(
      "%s (never sent) → definite DeliveryUnavailableError, one attempt",
      async (code) => {
        state.fault = { kind: "network", code };
        const err = await caught(client().postOnce(path, body, "json"));
        expect(err).toBeInstanceOf(DeliveryUnavailableError);
        expect(err).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    );

    it("401/403 → DeliveryAuthError; 400/422 → DeliveryConfigError (definite, not unknown)", async () => {
      for (const [status, cls] of [
        [401, DeliveryAuthError],
        [403, DeliveryAuthError],
        [400, DeliveryConfigError],
        [422, DeliveryConfigError],
      ] as const) {
        state.fault = { kind: "status", status };
        const err = await caught(client().postOnce(path, body, "json"));
        expect(err).toBeInstanceOf(cls);
        expect(err).not.toBeInstanceOf(DeliveryOutcomeUnknownError);
      }
    });

    it("encodes JSON only when the caller explicitly asks for it", async () => {
      await client().postOnce(path, body, "json");
      const req = state.requests[0];
      expect(req.method).toBe("POST");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(req.body!)).toEqual(body);
      expect(req.headers["c-api-key"]).toBe(FAKE_AMEEX_LIVE_KEY);
    });

    it("encodes x-www-form-urlencoded only when the caller explicitly asks for it", async () => {
      await client().postOnce(path, body, "form");
      const req = state.requests[0];
      expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(Object.fromEntries(new URLSearchParams(req.body!))).toEqual({
        type: "SIMPLE",
        receiver: "Test Fake",
        phone: "0600000000",
        city: "1",
        cod: "100",
      });
    });

    it("refuses a missing / unknown encoding before sending anything", async () => {
      await expect(
        client().postOnce(path, body, undefined as unknown as "json")
      ).rejects.toBeInstanceOf(DeliveryConfigError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("rate limiter (60 calls / minute per credential)", () => {
    it("blocks the 61st call within a minute, before sending, and frees up after the window", async () => {
      let now = 1_000_000;
      const limiter = new AmeexRateLimiter(60, 60_000, () => now);
      const c = client({ limiter });
      for (let i = 0; i < 60; i++) {
        await c.get("/Delivery/Parcels/Statuts");
        now += 500; // 60 calls spread over 30 s
      }
      expect(fetchMock).toHaveBeenCalledTimes(60);

      await expect(c.get("/Delivery/Parcels/Statuts")).rejects.toBeInstanceOf(DeliveryRateLimitError);
      await expect(c.postOnce("/p", { a: "1" }, "json")).rejects.toBeInstanceOf(DeliveryRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(60);

      // Slide past the first call's window — exactly one slot frees up.
      now = 1_000_000 + 60_000;
      await c.get("/Delivery/Parcels/Statuts");
      expect(fetchMock).toHaveBeenCalledTimes(61);
    });

    it("keys the window per credential", async () => {
      const now = 5_000;
      const limiter = new AmeexRateLimiter(2, 60_000, () => now);
      expect(limiter.tryAcquire("a")).toBe(true);
      expect(limiter.tryAcquire("a")).toBe(true);
      expect(limiter.tryAcquire("a")).toBe(false);
      expect(limiter.tryAcquire("b")).toBe(true);
    });

    it("counts each read retry as a call", async () => {
      let now = 0;
      const limiter = new AmeexRateLimiter(2, 60_000, () => now++);
      state.fault = { kind: "status", status: 500 };
      await expect(client({ limiter }).get("/x")).rejects.toBeInstanceOf(DeliveryRateLimitError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
