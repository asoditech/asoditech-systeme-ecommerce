import { vi } from "vitest";

/**
 * In-memory fake of the OzonExpress HTTP API for tests — no real network
 * call ever leaves the process. Mirrors tests/helpers/fake-reference-carrier.ts
 * and tests/helpers/fake-woocommerce.ts.
 *
 * The `tracking` response envelope here — `{ CHECK_API:{RESULT,MESSAGE},
 * TRACKING:{…, HISTORY:[…], LAST_TRACKING:{STATUT,…}} }` — matches what the
 * live OzonExpress API returned on 2026-09-01. ⚠️ The `add-parcel`,
 * `parcel-info`, and `/cities` shapes are still the Phase 23
 * reconstruction. See docs/adr/0013-ozonexpress-integration.md.
 */

export const FAKE_OZ_BASE_URL = "https://example.com"; // IANA doc domain — real DNS, SSRF check passes for real
export const FAKE_OZ_CUSTOMER_ID = "OZ-CUST-42";
export const FAKE_OZ_API_KEY = "oz_test_key_abcdef";

/** Default catalogue the fake `GET /cities` returns — real live shape:
 * each entry has ID / REF / NAME and per-city DELIVERED/RETURNED/REFUSED
 * prices. */
export const FAKE_OZ_CITIES = [
  { ID: 1, REF: "CAS", NAME: "Casablanca", "DELIVERED-PRICE": 20, "RETURNED-PRICE": 0, "REFUSED-PRICE": 10 },
  { ID: 2, REF: "RAB", NAME: "Rabat", "DELIVERED-PRICE": 25, "RETURNED-PRICE": 0, "REFUSED-PRICE": 10 },
  { ID: 3, REF: "MAR", NAME: "Marrakech", "DELIVERED-PRICE": 30, "RETURNED-PRICE": 0, "REFUSED-PRICE": 10 },
  { ID: 4, REF: "FES", NAME: "Fes", "DELIVERED-PRICE": 30, "RETURNED-PRICE": 0, "REFUSED-PRICE": 10 },
];

export interface FakeOzonExpressState {
  parcels: Map<
    string,
    { tracking: string; status: string; deliveredPrice: number | null; codPrice: string }
  >;
  nextId: number;
  /** add-parcel responds with this application error MESSAGE (HTTP 200, RESULT:ERROR). */
  forceAddParcelErrorMessage?: string;
  /** ANY credentialed POST responds with a top-level RESULT:ERROR + this MESSAGE. */
  forcePathErrorMessage?: string;
  /** ANY credentialed POST responds with a CHECK_API RESULT:ERROR + this
   * MESSAGE — the real shape of an auth / account rejection. */
  forceCheckApiErrorMessage?: string;
  /** add-parcel nests the error one level under "ADD-PARCEL" instead of top-level. */
  nestErrorEnvelope?: boolean;
  /** add-parcel returns the NEW-PARCEL body nested under ADD-PARCEL.NEW-PARCEL. */
  nestSuccessEnvelope?: boolean;
  /** add-parcel success body omits the tracking number entirely. */
  omitTrackingNumber?: boolean;
  /** add-parcel success body omits the price fields. */
  omitAddParcelPrice?: boolean;
  /** Any endpoint returns this HTTP status instead of succeeding. */
  forceHttpStatus?: number;
  /** Any endpoint returns non-JSON garbage. */
  malformedBody?: boolean;
  /** Every request hangs until aborted (timeout test). */
  hang?: boolean;
  /** Bad-credentials simulation: when true, any credentialed request with
   * non-matching customerId/apiKey path segments returns HTTP 200
   * RESULT:ERROR "Invalid API Key". */
  enforceAuth: boolean;
  /** `GET /cities` envelope: how the catalogue array is wrapped. */
  citiesEnvelope: "wrapped-CITIES" | "bare-array" | "wrapped-data";
  /** `GET /cities` returns this HTTP status instead of the catalogue. */
  forceCitiesHttpStatus?: number;
  /** Bon de Livraison — add-delivery-note responds with a body that has no
   * `ref` (malformed-response test). */
  deliveryNoteOmitRef?: boolean;
  /** Bon de Livraison — add-delivery-note nests the ref under
   * `DELIVERY-NOTE.ref` instead of a flat `ref`. */
  deliveryNoteNestRef?: boolean;
  /** Bon de Livraison — this step (`add-delivery-note` /
   * `add-parcel-to-delivery-note` / `save-delivery-note`) responds with a
   * top-level RESULT:ERROR + `deliveryNoteStepErrorMessage`. */
  deliveryNoteFailStep?: "add-delivery-note" | "add-parcel-to-delivery-note" | "save-delivery-note";
  deliveryNoteStepErrorMessage?: string;
  /** Records the `Codes[i]` values the fake saw on add-parcel-to-delivery-note. */
  seenManifestCodes?: string[];
  /** Delivery notes created by the fake, keyed by ref → the codes added. */
  deliveryNotes: Map<string, string[]>;
  nextDeliveryNoteId: number;
  /** Records the raw request URLs seen — tests assert the api key never
   * leaks elsewhere, and that path auth is used. */
  seenUrls: string[];
  /** Every `add-parcel` form body the fake received, in order — tests
   * assert which `parcel-city` id was actually sent to the carrier. */
  seenAddParcelForms: Record<string, string>[];
}

export function emptyFakeOzonExpressState(): FakeOzonExpressState {
  return {
    parcels: new Map(),
    nextId: 1,
    enforceAuth: true,
    citiesEnvelope: "wrapped-CITIES",
    seenUrls: [],
    seenAddParcelForms: [],
    deliveryNotes: new Map(),
    nextDeliveryNoteId: 1,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function citiesBody(state: FakeOzonExpressState) {
  // Real live shape: CITIES is an OBJECT keyed by id string.
  const asMap = Object.fromEntries(FAKE_OZ_CITIES.map((c) => [String(c.ID), c]));
  switch (state.citiesEnvelope) {
    case "bare-array":
      return FAKE_OZ_CITIES;
    case "wrapped-data":
      return { data: FAKE_OZ_CITIES };
    default:
      return { CITIES: asMap };
  }
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
      const method = (init?.method ?? "GET").toUpperCase();

      // GET /cities — un-credentialed destination catalogue.
      if (method === "GET" && url.pathname.replace(/\/+$/, "") === "/cities") {
        if (state.forceCitiesHttpStatus) return json({ error: "forced" }, state.forceCitiesHttpStatus);
        if (state.malformedBody) return new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
        return json(citiesBody(state));
      }

      // /customers/{cid}/{key}/{action}
      const m = url.pathname.match(/^\/customers\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!m) return json({ RESULT: "ERROR", MESSAGE: "Unknown endpoint" }, 404);
      const [, cid, key, action] = m;

      if (state.enforceAuth && (decodeURIComponent(cid) !== FAKE_OZ_CUSTOMER_ID || decodeURIComponent(key) !== FAKE_OZ_API_KEY)) {
        // Real shape: the auth failure comes back in the CHECK_API block.
        return json({ CHECK_API: { RESULT: "ERROR", MESSAGE: "Invalid API Key" } });
      }

      if (state.forceHttpStatus) return json({ RESULT: "ERROR", MESSAGE: "forced" }, state.forceHttpStatus);
      if (state.malformedBody) return new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } });
      if (state.forceCheckApiErrorMessage) return json({ CHECK_API: { RESULT: "ERROR", MESSAGE: state.forceCheckApiErrorMessage } });
      if (state.forcePathErrorMessage) return json({ RESULT: "ERROR", MESSAGE: state.forcePathErrorMessage });

      const form = init?.body instanceof FormData ? init.body : new FormData();

      if (action === "add-parcel") {
        state.seenAddParcelForms.push(Object.fromEntries(form.entries()) as Record<string, string>);
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
              ...(state.omitAddParcelPrice
                ? {}
                : { "DELIVERED-PRICE": "25.00", "RETURNED-PRICE": "15.00", "REFUSED-PRICE": "15.00" }),
              STATUS: "Nouveau colis",
            };
        return json(
          state.nestSuccessEnvelope ? { "ADD-PARCEL": { RESULT: "SUCCESS", "NEW-PARCEL": bodyFields } } : bodyFields
        );
      }

      // Real envelope: every credentialed response carries a CHECK_API
      // auth block; `tracking` wraps its payload under `TRACKING` with a
      // HISTORY array and a LAST_TRACKING block.
      const CHECK_API = { RESULT: "SUCCESS", MESSAGE: "Valide API Key" };

      if (action === "tracking") {
        const tn = String(form.get("tracking-number") ?? "").trim();
        if (tn === "") {
          // Empty code -> OzonExpress returns a canned demo TRACKING plus
          // the CHECK_API block. This is what the connection test relies on.
          return json({
            CHECK_API,
            TRACKING: {
              "TRACKING-NUMBER": "",
              RESULT: "SUCCESS",
              MESSAGE: "Valid tracking number",
              HISTORY: [
                { STATUT: "Nouveau Colis", TIME: "1702654488", TIME_STR: "2023-12-15 16:34", COMMENT: "" },
                { STATUT: "Mise en distribution", TIME: "1702714786", TIME_STR: "2023-12-16 09:19", COMMENT: "" },
              ],
              LAST_TRACKING: { STATUT: "Mise en distribution", TIME: "1702714786", TIME_STR: "2023-12-16 09:19", COMMENT: "" },
            },
          });
        }
        const parcel = state.parcels.get(tn);
        if (!parcel) {
          return json({ CHECK_API, TRACKING: { "TRACKING-NUMBER": tn, RESULT: "ERROR", MESSAGE: "Tracking number not found" } });
        }
        return json({
          CHECK_API,
          TRACKING: {
            "TRACKING-NUMBER": parcel.tracking,
            RESULT: "SUCCESS",
            MESSAGE: "Valid tracking number",
            HISTORY: [{ STATUT: "Nouveau Colis", TIME: "1", TIME_STR: "", COMMENT: "" }, { STATUT: parcel.status, TIME: "2", TIME_STR: "", COMMENT: "" }],
            LAST_TRACKING: { STATUT: parcel.status, TIME: "2", TIME_STR: "", COMMENT: "" },
            "DELIVERED-PRICE": parcel.deliveredPrice === null ? null : String(parcel.deliveredPrice.toFixed(2)),
          },
        });
      }

      if (action === "parcel-info") {
        const tn = String(form.get("tracking-number") ?? "").trim();
        const parcel = state.parcels.get(tn);
        if (!parcel) return json({ CHECK_API, "PARCEL-INFO": { RESULT: "ERROR", MESSAGE: "Parcel not found" } });
        return json({
          CHECK_API,
          "PARCEL-INFO": {
            "TRACKING-NUMBER": parcel.tracking,
            STATUS: parcel.status,
            "DELIVERED-PRICE": parcel.deliveredPrice === null ? null : String(parcel.deliveredPrice.toFixed(2)),
          },
        });
      }

      // ── Bon de Livraison (delivery note / manifest) — 4-step flow.
      // ⚠️ Reconstruction from owner docs, not live-verified — see
      // docs/adr/0015-delivery-manifest.md.
      if (action === "add-delivery-note") {
        if (state.deliveryNoteFailStep === "add-delivery-note") {
          return json({ RESULT: "ERROR", MESSAGE: state.deliveryNoteStepErrorMessage ?? "delivery note failed" });
        }
        const ref = `BL${state.nextDeliveryNoteId++}${Date.now() % 10000}`;
        state.deliveryNotes.set(ref, []);
        if (state.deliveryNoteOmitRef) return json({ RESULT: "SUCCESS" });
        return json(state.deliveryNoteNestRef ? { "DELIVERY-NOTE": { ref } } : { ref });
      }

      if (action === "add-parcel-to-delivery-note") {
        if (state.deliveryNoteFailStep === "add-parcel-to-delivery-note") {
          return json({ RESULT: "ERROR", MESSAGE: state.deliveryNoteStepErrorMessage ?? "add parcels failed" });
        }
        const ref = String(form.get("Ref") ?? "").trim();
        const codes: string[] = [];
        for (const [k, v] of form.entries()) {
          if (/^Codes\[\d+\]$/.test(k)) codes.push(String(v));
        }
        state.seenManifestCodes = codes;
        if (state.deliveryNotes.has(ref)) state.deliveryNotes.set(ref, codes);
        return json({ RESULT: "SUCCESS" });
      }

      if (action === "save-delivery-note") {
        if (state.deliveryNoteFailStep === "save-delivery-note") {
          return json({ RESULT: "ERROR", MESSAGE: state.deliveryNoteStepErrorMessage ?? "save failed" });
        }
        return json({ RESULT: "SUCCESS" });
      }

      // POST cities via the credentialed path (the fallback the adapter tries).
      if (action.replace(/\/+$/, "") === "cities") {
        if (state.forceCitiesHttpStatus) return json({ error: "forced" }, state.forceCitiesHttpStatus);
        return json(citiesBody(state));
      }

      return json({ RESULT: "ERROR", MESSAGE: "Unknown action" }, 404);
    })
  );
}
