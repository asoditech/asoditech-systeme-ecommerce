import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No real DNS: assertPublicHost's lookup is stubbed (default: a public IP).
const dns = vi.hoisted(() => ({
  lookup: vi.fn<(host: string, opts?: unknown) => Promise<{ address: string; family: number }[]>>(async () => [
    { address: "93.184.216.34", family: 4 },
  ]),
}));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

import {
  __clearSenditTokenCacheForTests,
  __hasCachedSenditTokenForTests,
  SENDIT_TOKEN_TTL_MS,
  SenditClient,
} from "@/lib/integrations/delivery/providers/sendit/client";
import { SENDIT_BASE_URL } from "@/lib/integrations/delivery/providers/sendit/types";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
  DeliveryPermissionError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import {
  abortError,
  emptyFakeSenditState,
  FAKE_SENDIT_PUBLIC_KEY,
  FAKE_SENDIT_SECRET_KEY,
  FAKE_SENDIT_TOKEN,
  installFakeSendit,
  json,
  networkError,
  ok,
  path,
  type FakeSenditState,
} from "../helpers/fake-sendit";

const creds = { publicKey: FAKE_SENDIT_PUBLIC_KEY, secretKey: FAKE_SENDIT_SECRET_KEY };
let state: FakeSenditState;
let now = 1_000_000;

function client() {
  return new SenditClient(creds, { timeoutMs: 1000, sleep: async () => {}, now: () => now });
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
  expect(dump).not.toContain(FAKE_SENDIT_SECRET_KEY);
  expect(dump).not.toContain(FAKE_SENDIT_PUBLIC_KEY);
  expect(dump).not.toContain(FAKE_SENDIT_TOKEN);
  expect(dump).not.toContain("app.sendit.ma");
}

const logins = () => state.requests.filter((r) => path(r) === "login");
const creates = () => state.requests.filter((r) => path(r) === "deliveries" && r.method === "POST");

describe("SenditClient", () => {
  beforeEach(() => {
    state = emptyFakeSenditState();
    installFakeSendit(state);
    __clearSenditTokenCacheForTests();
    now = 1_000_000;
    dns.lookup.mockClear();
    dns.lookup.mockImplementation(async () => [{ address: "93.184.216.34", family: 4 }]);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("login + Bearer header", () => {
    it("logs in with public_key/secret_key, then sends Authorization: Bearer <token> to the fixed https base", async () => {
      state.routes.push((r) => (path(r) === "districts" ? ok([]) : undefined));
      await client().get("districts", { page: 1 });
      expect(state.requests).toHaveLength(2);
      const [login, read] = state.requests;
      expect(login.url).toBe(`${SENDIT_BASE_URL}/login`);
      expect(login.method).toBe("POST");
      expect(login.body).toEqual({ public_key: FAKE_SENDIT_PUBLIC_KEY, secret_key: FAKE_SENDIT_SECRET_KEY });
      expect(login.headers["authorization"]).toBeUndefined();
      expect(read.url).toBe(`${SENDIT_BASE_URL}/districts?page=1`);
      expect(read.url.startsWith("https://app.sendit.ma/api/v1/")).toBe(true);
      expect(read.headers["authorization"]).toBe(`Bearer ${FAKE_SENDIT_TOKEN}`);
      // Keys never in a URL
      for (const r of state.requests) {
        expect(r.url).not.toContain(FAKE_SENDIT_SECRET_KEY);
        expect(r.url).not.toContain(FAKE_SENDIT_TOKEN);
      }
    });

    it("uses redirect: error on every request", async () => {
      const mock = installFakeSendit(state);
      state.routes.push((r) => (path(r) === "districts" ? ok([]) : undefined));
      await client().get("districts");
      for (const call of mock.mock.calls) expect((call[1] as RequestInit).redirect).toBe("error");
    });

    it("login 401 → DeliveryAuthError, no secret in the error", async () => {
      state.routes.push((r) => (path(r) === "login" ? json(401, { success: false, message: FAKE_SENDIT_SECRET_KEY }) : undefined));
      const err = await caught(client().token());
      expect(err).toBeInstanceOf(DeliveryAuthError);
      expectNoSecretLeak(err);
    });

    it("login success:false → DeliveryAuthError", async () => {
      state.routes.push((r) => (path(r) === "login" ? json(200, { success: false, message: "bad" }) : undefined));
      expect(await caught(client().token())).toBeInstanceOf(DeliveryAuthError);
    });
  });

  describe("token cache", () => {
    it("reuses the cached token across client instances (keyed by a hash of the pair)", async () => {
      state.routes.push((r) => (path(r) === "districts" ? ok([]) : undefined));
      await client().get("districts");
      await client().get("districts");
      expect(logins()).toHaveLength(1);
      expect(__hasCachedSenditTokenForTests(creds)).toBe(true);
    });

    it("logs in again after the conservative TTL", async () => {
      state.routes.push((r) => (path(r) === "districts" ? ok([]) : undefined));
      await client().get("districts");
      now += SENDIT_TOKEN_TTL_MS + 1;
      await client().get("districts");
      expect(logins()).toHaveLength(2);
    });

    it("re-logs in ONCE on 401 and repeats the read with the new token", async () => {
      state.loginTokens = ["old-token", "new-token"];
      state.routes.push((r) =>
        path(r) === "districts" ? (r.headers["authorization"] === "Bearer old-token" ? json(401, {}) : ok([])) : undefined
      );
      await client().get("districts");
      expect(logins()).toHaveLength(2);
      const reads = state.requests.filter((r) => path(r) === "districts");
      expect(reads.map((r) => r.headers["authorization"])).toEqual(["Bearer old-token", "Bearer new-token"]);
    });

    it("a second 401 after re-login → DeliveryAuthError, token dropped", async () => {
      state.routes.push((r) => (path(r) === "districts" ? json(401, {}) : undefined));
      const err = await caught(client().get("districts"));
      expect(err).toBeInstanceOf(DeliveryAuthError);
      expect(logins()).toHaveLength(2);
      expect(state.requests.filter((r) => path(r) === "districts")).toHaveLength(2);
      expect(__hasCachedSenditTokenForTests(creds)).toBe(false);
      expectNoSecretLeak(err);
    });
  });

  describe("reads", () => {
    it("retries 5xx / 429 / network errors, then succeeds", async () => {
      let n = 0;
      state.routes.push((r) => {
        if (path(r) !== "districts") return undefined;
        n++;
        if (n === 1) return json(503, {});
        if (n === 2) return networkError("ECONNRESET");
        return ok([]);
      });
      await client().get("districts");
      expect(n).toBe(3);
    });

    it("gives up after 3 attempts with a typed error", async () => {
      state.routes.push((r) => (path(r) === "districts" ? json(500, { message: FAKE_SENDIT_TOKEN }) : undefined));
      const err = await caught(client().get("districts"));
      expect(err).toBeInstanceOf(DeliveryUnavailableError);
      expect(state.requests.filter((r) => path(r) === "districts")).toHaveLength(3);
      expectNoSecretLeak(err);
    });

    it("timeout → DeliveryTimeoutError, not retried", async () => {
      state.routes.push((r) => (path(r) === "districts" ? abortError() : undefined));
      expect(await caught(client().get("districts"))).toBeInstanceOf(DeliveryTimeoutError);
      expect(state.requests.filter((r) => path(r) === "districts")).toHaveLength(1);
    });

    it("unreadable 2xx → malformed", async () => {
      state.routes.push((r) => (path(r) === "districts" ? new Response("<html>", { status: 200 }) : undefined));
      expect(await caught(client().get("districts"))).toBeInstanceOf(DeliveryMalformedResponseError);
    });
  });

  describe("createOnce — exactly one attempt", () => {
    const body = { district_id: 1, name: "A" };

    it.each([
      ["timeout", () => abortError()],
      ["connection reset", () => networkError("ECONNRESET")],
      ["500", () => json(500, {})],
      ["502", () => json(502, {})],
      ["429", () => json(429, {})],
      ["unreadable 2xx", () => new Response("not json", { status: 200 })],
    ] as const)("%s → DeliveryOutcomeUnknownError and never a second create", async (_label, make) => {
      state.routes.push((r) => (path(r) === "deliveries" && r.method === "POST" ? make() : undefined));
      const err = await caught(client().createOnce("deliveries", body));
      expect(err).toBeInstanceOf(DeliveryOutcomeUnknownError);
      expect(creates()).toHaveLength(1);
      expectNoSecretLeak(err);
    });

    it("connection refused (never sent) → definite DeliveryUnavailableError", async () => {
      state.routes.push((r) => (path(r) === "deliveries" ? networkError("ECONNREFUSED") : undefined));
      expect(await caught(client().createOnce("deliveries", body))).toBeInstanceOf(DeliveryUnavailableError);
      expect(creates()).toHaveLength(1);
    });

    it("401 → DeliveryAuthError, no re-login, no second create", async () => {
      state.routes.push((r) => (path(r) === "deliveries" ? json(401, {}) : undefined));
      const err = await caught(client().createOnce("deliveries", body));
      expect(err).toBeInstanceOf(DeliveryAuthError);
      expect(creates()).toHaveLength(1);
      expect(logins()).toHaveLength(1);
      expect(__hasCachedSenditTokenForTests(creds)).toBe(false);
    });

    it("403 → permission error", async () => {
      state.routes.push((r) => (path(r) === "deliveries" ? json(403, {}) : undefined));
      expect(await caught(client().createOnce("deliveries", body))).toBeInstanceOf(DeliveryPermissionError);
    });

    it.each([400, 422, 250, 251, 252])("%i → DeliveryConfigError with a fixed French message (body/credentials never echoed)", async (status) => {
      const echo = { success: false, message: `${FAKE_SENDIT_SECRET_KEY} ${FAKE_SENDIT_TOKEN} https://app.sendit.ma/x` };
      state.routes.push((r) => (path(r) === "deliveries" ? json(status, echo) : undefined));
      const err = await caught(client().createOnce("deliveries", body));
      expect(err).toBeInstanceOf(DeliveryConfigError);
      expect(err.message).toMatch(/Sendit/);
      expectNoSecretLeak(err);
      expect(creates()).toHaveLength(1);
    });

    it("sends JSON with the Bearer token and returns the parsed body", async () => {
      state.routes.push((r) => (path(r) === "deliveries" ? ok({ code: "D1" }) : undefined));
      const raw = await client().createOnce("deliveries", body);
      expect(raw).toMatchObject({ success: true, data: { code: "D1" } });
      const c = creates()[0];
      expect(c.headers["content-type"]).toBe("application/json");
      expect(c.headers["authorization"]).toBe(`Bearer ${FAKE_SENDIT_TOKEN}`);
      expect(c.body).toEqual(body);
    });
  });

  describe("https / host guard", () => {
    it("refuses a private-IP resolution before sending anything (SSRF / DNS rebinding)", async () => {
      dns.lookup.mockImplementation(async () => [{ address: "10.0.0.5", family: 4 }]);
      const err = await caught(client().get("districts"));
      expect(err).toBeInstanceOf(DeliveryConfigError);
      expect(state.requests).toHaveLength(0);
    });

    it("re-checks the host before the create request too", async () => {
      await client().token();
      dns.lookup.mockImplementation(async () => [{ address: "127.0.0.1", family: 4 }]);
      expect(await caught(client().createOnce("deliveries", {}))).toBeInstanceOf(DeliveryConfigError);
      expect(creates()).toHaveLength(0);
    });

    it("the base URL is fixed https and not overridable", async () => {
      expect(SENDIT_BASE_URL).toBe("https://app.sendit.ma/api/v1");
      // No baseUrl option exists: an unknown option is ignored.
      state.routes.push((r) => (path(r) === "districts" ? ok([]) : undefined));
      const c = new SenditClient(creds, { baseUrl: "http://evil.test", sleep: async () => {} } as never);
      await c.get("districts");
      for (const r of state.requests) expect(new URL(r.url).origin).toBe("https://app.sendit.ma");
    });
  });
});
