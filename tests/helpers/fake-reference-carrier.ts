import { vi } from "vitest";

/**
 * A minimal in-memory fake HTTP server for the __test_reference__ delivery
 * adapter (tests/helpers/reference-delivery-provider.ts) — no real network
 * call ever leaves the process. Mirrors tests/helpers/fake-woocommerce.ts's
 * approach for the same reasons: the adapter/service/action layer is
 * tested end-to-end against the real test database without a live
 * external account. See docs/adr/0012-delivery-provider-integration.md.
 */
export const FAKE_API_KEY = "ref_test_key_123";

export interface FakeCarrierState {
  shipments: Map<string, { id: string; status: string; tracking_number: string | null; tracking_url: string | null; cost: number | null }>;
  nextId: number;
  /** When set, /shipments (create) responds with this HTTP status instead
   * of succeeding — used to test provider-rejection handling. */
  forceCreateStatus?: number;
  /** When set, /account responds with this status — used to test
   * connection-test failure. */
  forceAccountStatus?: number;
  /** When true, the create response is missing required fields — used to
   * test malformed-response handling. */
  malformedCreateResponse?: boolean;
  /** When true, every request hangs until aborted — used to test timeout
   * handling. */
  hang?: boolean;
}

export function emptyFakeCarrierState(): FakeCarrierState {
  return { shipments: new Map(), nextId: 1 };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function checkAuth(init: RequestInit | undefined): boolean {
  const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
  return auth === `Bearer ${FAKE_API_KEY}`;
}

/** Installs the fake fetch. Call in beforeEach; call vi.unstubAllGlobals() in afterEach. */
export function installFakeReferenceCarrier(state: FakeCarrierState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (state.hang) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }

      const url = new URL(input.toString());
      if (!checkAuth(init)) return jsonResponse({ error: "unauthorized" }, 401);

      const path = url.pathname;
      const method = init?.method ?? "GET";

      if (path === "/account" && method === "GET") {
        return state.forceAccountStatus ? jsonResponse({ error: "forced" }, state.forceAccountStatus) : jsonResponse({ ok: true });
      }

      if (path === "/shipments" && method === "POST") {
        if (state.forceCreateStatus) return jsonResponse({ error: "forced" }, state.forceCreateStatus);
        if (state.malformedCreateResponse) return jsonResponse({ unexpected: "shape" });
        const id = `ref-${state.nextId++}`;
        const record = { id, status: "created", tracking_number: `TRK-${id}`, tracking_url: `https://example.com/track/${id}`, cost: 25.5 };
        state.shipments.set(id, record);
        return jsonResponse(record);
      }

      const cancelMatch = path.match(/^\/shipments\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        const record = state.shipments.get(cancelMatch[1]);
        if (!record) return jsonResponse({ error: "not found" }, 404);
        record.status = "cancelled";
        return jsonResponse({ ok: true });
      }

      const statusMatch = path.match(/^\/shipments\/([^/]+)$/);
      if (statusMatch && method === "GET") {
        const record = state.shipments.get(statusMatch[1]);
        if (!record) return jsonResponse({ error: "not found" }, 404);
        return jsonResponse({ status: record.status, tracking_url: record.tracking_url, cost: record.cost });
      }

      return jsonResponse({ error: "not found" }, 404);
    })
  );
}
