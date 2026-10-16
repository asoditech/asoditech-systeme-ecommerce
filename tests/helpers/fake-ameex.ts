import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

/**
 * In-memory fake of the Ameex HTTP API — no real network call ever leaves
 * the process (`fetch` is stubbed with vi.stubGlobal). The default success
 * body is a deliberately opaque JSON object (client-level tests); adapter
 * tests set `respond` to answer with the REAL sandbox bodies from
 * tests/fixtures/ameex/sandbox-responses-2026-10-16.json (`ameexFixture`).
 *
 * Every value below is an obviously fake test value — never a real
 * credential.
 */

export const FAKE_AMEEX_API_ID = "fake-customer-0000";
export const FAKE_AMEEX_LIVE_KEY = "live_FAKE_KEY_do_not_use_0000000000";
export const FAKE_AMEEX_SANDBOX_KEY = "test_FAKE_SANDBOX_KEY_0000000000";
export const FAKE_AMEEX_WEBHOOK_SECRET = "fake-webhook-secret-for-tests";

/** A public, documentation-safe IP the stubbed DNS lookup answers with. */
export const FAKE_PUBLIC_IP = "93.184.216.34";

export interface FakeAmeexRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export type FakeAmeexFault =
  | { kind: "status"; status: number }
  | { kind: "hang" }
  | { kind: "network"; code: string }
  | { kind: "malformed" };

export interface FakeAmeexState {
  requests: FakeAmeexRequest[];
  /** Applied to every request unless `sequence` has an entry left. */
  fault?: FakeAmeexFault;
  /** Per-call faults consumed in order; `null` = succeed normally. */
  sequence: (FakeAmeexFault | null)[];
  /** JSON body returned on success. */
  successBody: unknown;
  /** Optional per-request success body (takes precedence over successBody). */
  respond?: (req: FakeAmeexRequest) => unknown;
}

export function emptyFakeAmeexState(): FakeAmeexState {
  return { requests: [], sequence: [], successBody: { opaque: "fake-ameex-body" } };
}

function headersToRecord(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  new Headers(h).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function hang(init?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
}

export function installFakeAmeex(state: FakeAmeexState) {
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    state.requests.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url: input.toString(),
      headers: headersToRecord(init),
      body: typeof init?.body === "string" ? init.body : null,
    });

    const fault = state.sequence.length > 0 ? state.sequence.shift() : state.fault;
    if (fault) {
      switch (fault.kind) {
        case "hang":
          return hang(init);
        case "network":
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("network"), { code: fault.code }) });
        case "malformed":
          return new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
        case "status":
          return new Response(JSON.stringify({ error: "forced" }), {
            status: fault.status,
            headers: { "content-type": "application/json" },
          });
      }
    }
    const body = state.respond ? state.respond(state.requests[state.requests.length - 1]) : state.successBody;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Builds a valid `X-Ameex-Signature` header for `rawBody` (documented algorithm). */
export function signAmeex(rawBody: string, secret: string, tSeconds: number): string {
  const v1 = createHmac("sha256", secret).update(`${tSeconds}.${rawBody}`, "utf8").digest("hex");
  return `t=${tSeconds},v1=${v1}`;
}

/** A documented-shape (form-encoded) Ameex webhook body. */
export function ameexWebhookBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Real Ameex SANDBOX responses captured 2026-10-16 (credentials removed). */
export const ameexFixture = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../fixtures/ameex/sandbox-responses-2026-10-16.json"), "utf8")
) as Record<string, unknown> & {
  statuts: { api: { data: { status: Record<string, { type: string; name: string; color: string }> } } };
  cities: { api: { cities: Record<string, { id: number; name: string }> } };
  tracking: { api: { tracking: Record<string, unknown>[] } };
};
