import { vi } from "vitest";

/**
 * In-memory fake of the OzonExpress HTTP API for tests — no real network
 * call ever leaves the process. Mirrors tests/helpers/fake-reference-carrier.ts
 * and tests/helpers/fake-woocommerce.ts.
 *
 * ⚠️ This fake encodes the SAME unverified, community-reconstructed
 * contract as the adapter under test (base URL shape, path auth, multipart
 * bodies, the "HTTP 200 with RESULT:ERROR" quirk, flat vs nested
 * envelopes). It proves the adapter is internally consistent and handles
 * every documented-by-community failure mode — it does NOT prove the
 * contract itself is what OzonExpress really returns. See
 * docs/adr/0013-ozonexpress-integration.md.
 */

export const FAKE_OZ_BASE_URL = "https://example.com"; // IANA doc domain — real DNS, SSRF check passes for real
export const FAKE_OZ_CUSTOMER_ID = "OZ-CUST-42";
export const FAKE_OZ_API_KEY = "oz_test_key_abcdef";

export interface FakeOzonExpressState {
  parcels: Map<
    string,
    { tracking: string; status: string; deliveredPrice: number | null; codPrice: string }
  >;
  nextId: number;
  /** add-parcel responds with this application error MESSAGE (HTTP 200, RESULT:ERROR). */
  forceAddParcelErrorMessage?: string;
  /** add-parcel nests the error one level under "ADD-PARCEL" instead of top-level. */
  nestErrorEnvelope?: boolean;
  /** add-parcel returns the NEW-PARCEL body nested under ADD-PARCEL.NEW-PARCEL. */
  nestSuccessEnvelope?: boolean;
  /** add-parcel success body omits the tracking number entirely. */
  omitTrackingNumber?: boolean;
  /** Any endpoint returns this HTTP status instead of succeeding. */
  forceHttpStatus?: number;
  /** Any endpoint returns non-JSON garbage. */
  malformedBody?: boolean;
  /** Every request hangs until aborted (timeout test). */
  hang?: boolean;
  /** Bad-credentials simulation: when true, any request with non-matching
   * customerId/apiKey path segments returns HTTP 200 RESULT:ERROR "Invalid API Key". */
  enforceAuth: boolean;
  /** Records the raw request URLs seen — tests assert the api key never
   * leaks elsewhere, and that path auth is used. */
  seenUrls: string[];
}

export function emptyFakeOzonExpressState(): FakeOzonExpressState {
  return { parcels: new Map(), nextId: 1, enforceAuth: true, seenUrls: [] };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installFakeOzonExpress(state: FakeOzonExpressState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const urlStr = input.toString();
      state.seenUrls.push(urlStr);

      if (state.hang) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }

      const url = new URL(urlStr);
      // /customers/{cid}/{key}/{action}
      const m = url.pathname.match(/^\/customers\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!m) return json({ RESULT: "ERROR", MESSAGE: "Unknown endpoint" }, 404);
      const [, cid, key, action] = m;

      if (state.enforceAuth && (decodeURIComponent(cid) !== FAKE_OZ_CUSTOMER_ID || decodeURIComponent(key) !== FAKE_OZ_API_KEY)) {
        return json({ RESULT: "ERROR", MESSAGE: "Invalid API Key or Customer ID" });
      }

      if (state.forceHttpStatus) return json({ RESULT: "ERROR", MESSAGE: "forced" }, state.forceHttpStatus);
      if (state.malformedBody) return new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });

      const form = init?.body instanceof FormData ? init.body : new FormData();

      if (action === "add-parcel") {
        if (state.forceAddParcelErrorMessage) {
          const err = { RESULT: "ERROR", MESSAGE: state.forceAddParcelErrorMessage };
          return json(state.nestErrorEnvelope ? { "ADD-PARCEL": err } : err);
        }
        const custom = String(form.get("tracking-number") ?? "").trim();
        const tracking = custom || `OZE${state.nextId++}${Date.now() % 100000}`;
        // Idempotency: a repeated custom tracking number is rejected.
        if (custom && state.parcels.has(custom)) {
          return json({ RESULT: "ERROR", MESSAGE: "Tracking number already exists" });
        }
        state.parcels.set(tracking, {
          tracking,
          status: "Nouveau colis",
          deliveredPrice: 25,
          codPrice: String(form.get("parcel-price") ?? "0"),
        });
        const bodyFields: Record<string, unknown> = state.omitTrackingNumber
          ? { RECEIVER: form.get("parcel-receiver"), "DELIVERED-PRICE": "25.00" }
          : {
              "TRACKING-NUMBER": tracking,
              RECEIVER: form.get("parcel-receiver"),
              PHONE: form.get("parcel-phone"),
              CITY_ID: form.get("parcel-city"),
              PRICE: form.get("parcel-price"),
              "DELIVERED-PRICE": "25.00",
              "RETURNED-PRICE": "15.00",
              "REFUSED-PRICE": "15.00",
              STATUS: "Nouveau colis",
            };
        return json(
          state.nestSuccessEnvelope ? { "ADD-PARCEL": { RESULT: "SUCCESS", "NEW-PARCEL": bodyFields } } : bodyFields
        );
      }

      if (action === "tracking" || action === "parcel-info") {
        const tn = String(form.get("tracking-number") ?? "").trim();
        const parcel = state.parcels.get(tn);
        if (!parcel) return json({ RESULT: "ERROR", MESSAGE: "Parcel not found" });
        return json({
          "TRACKING-NUMBER": parcel.tracking,
          STATUS: parcel.status,
          "DELIVERED-PRICE": parcel.deliveredPrice === null ? null : String(parcel.deliveredPrice.toFixed(2)),
        });
      }

      return json({ RESULT: "ERROR", MESSAGE: "Unknown action" }, 404);
    })
  );
}
