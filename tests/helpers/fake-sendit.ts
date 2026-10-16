import { vi } from "vitest";

/**
 * Stubbed `fetch` for the Sendit client/adapter tests — NO network. Each test
 * pushes route handlers; every request is recorded (url, method, headers,
 * parsed JSON body). Credentials below are obvious fakes.
 */

export const FAKE_SENDIT_PUBLIC_KEY = "fake-public-key-0001";
export const FAKE_SENDIT_SECRET_KEY = "fake-secret-key-SHOULD-NEVER-LEAK";
export const FAKE_SENDIT_TOKEN = "fake.jwt.token-SHOULD-NEVER-LEAK";

export interface RecordedSenditRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type SenditRouteResult = Response | Error | (() => Response | Promise<Response>);
export type SenditRoute = (req: RecordedSenditRequest) => SenditRouteResult | undefined;

export interface FakeSenditState {
  requests: RecordedSenditRequest[];
  routes: SenditRoute[];
  /** Token returned by POST /login (can be changed per test). */
  loginTokens: string[];
}

export function emptyFakeSenditState(): FakeSenditState {
  return { requests: [], routes: [], loginTokens: [FAKE_SENDIT_TOKEN] };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function ok(data: unknown, extra: Record<string, unknown> = {}): Response {
  return json(200, { success: true, message: "ok", data, ...extra });
}

export function path(req: RecordedSenditRequest): string {
  return new URL(req.url).pathname.replace(/^\/api\/v1\//, "");
}

export function installFakeSendit(state: FakeSenditState) {
  let loginCount = 0;
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: RecordedSenditRequest = { url: String(input), method: init?.method ?? "GET", headers, body };
    state.requests.push(req);
    for (const route of state.routes) {
      const r = route(req);
      if (r === undefined) continue;
      if (r instanceof Error) throw r;
      return typeof r === "function" ? await r() : r;
    }
    if (path(req) === "login" && req.method === "POST") {
      const token = state.loginTokens[Math.min(loginCount, state.loginTokens.length - 1)];
      loginCount++;
      return ok({ token, name: "owner@example.test" });
    }
    return json(404, { success: false, message: "not found" });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function networkError(code: string): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = { code };
  return err;
}

export function abortError(): Error {
  return new DOMException("aborted", "AbortError");
}

export function deliveryDetail(overrides: Record<string, unknown> = {}) {
  return {
    code: "DABC1234",
    status: "PENDING",
    fee: 35,
    name: "Client Test",
    phone: "0600000000",
    address: "Adresse",
    amount: 199,
    reference: "CMD-1",
    district: { id: 1, ville: "Casablanca", name: "Casablanca - Ain sebaa", price: 19, delais: "24h", active: 1 },
    last_action_at: "2026-10-01 10:00:00",
    status_return: null,
    labelUrl: "https://app.sendit.ma/labels/x.pdf?expires=1&signature=abc",
    audits: [],
    ...overrides,
  };
}
