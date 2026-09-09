import "server-only";

import { assertPublicHost, InvalidHostError } from "@/lib/integrations/shared";
import {
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import { errorForNotifications, errorForStatus } from "./errors";
import { aramexEnvelopeSchema, type AramexCredentials } from "./types";

/**
 * Thin, centralized Aramex JSON client. Every call the adapter makes goes
 * through `post(service, endpoint, payload)` — one place for building the
 * `ClientInfo` block, SSRF re-validation, timeout, retry, and the
 * "HTTP 200 that is actually `HasErrors: true`" unwrapping.
 *
 * Aramex authenticates with a `ClientInfo` object INSIDE the JSON body
 * (not a header), so the whole request body is a secret. This client
 * never puts a body, URL, or credential into a thrown value or return
 * value — errors carry a fixed French string or Aramex's own (sanitised)
 * notification text. See docs/adr/0028-aramex-integration.md ("Credentials").
 */

// Live hosts. Aramex also publishes a full sandbox on `ws.dev.aramex.net`
// with the same paths (docs/aramex_carrier_integration_doc.md §2) — used
// when the connector config sets `sandbox: true`.
const PRODUCTION_SHIPPING_BASE_URL = "https://ws.aramex.net/ShippingAPI.V2/Shipping";
const PRODUCTION_TRACKING_BASE_URL = "https://ws.aramex.net/ShippingAPI/Tracking";
const PRODUCTION_RATE_BASE_URL = "https://ws.aramex.net/ShippingAPI.V2/RateCalculator";
const SANDBOX_SHIPPING_BASE_URL = "https://ws.dev.aramex.net/ShippingAPI.V2/Shipping";
const SANDBOX_TRACKING_BASE_URL = "https://ws.dev.aramex.net/ShippingAPI/Tracking";
const SANDBOX_RATE_BASE_URL = "https://ws.dev.aramex.net/ShippingAPI.V2/RateCalculator";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_SOURCE = 24;
const MAX_RETRIES = 3;

export type AramexService = "shipping" | "tracking" | "rate";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `unknown` → number | null without ever coercing missing / empty /
 * non-numeric to 0 (see docs/adr/0012 "Delivery cost"). */
export function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface AramexClientOptions {
  timeoutMs?: number;
  source?: number;
  /** Route every call to Aramex's `ws.dev.aramex.net` sandbox. An explicit
   * `*BaseUrl` override still wins over this. */
  sandbox?: boolean;
  shippingBaseUrl?: string;
  trackingBaseUrl?: string;
  rateBaseUrl?: string;
}

export class AramexClient {
  private readonly timeoutMs: number;
  private readonly source: number;
  private readonly bases: Record<AramexService, string>;
  private readonly clientInfo: Record<string, string | number>;

  constructor(credentials: AramexCredentials, options: AramexClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.source = options.source ?? DEFAULT_SOURCE;

    const normalizeBase = (raw: string | undefined, fallback: string, label: string): string => {
      const base = (raw ?? fallback).replace(/\/+$/, "");
      let parsed: URL;
      try {
        parsed = new URL(base);
      } catch {
        throw new DeliveryConfigError(`L'URL ${label} Aramex configurée est invalide.`);
      }
      if (parsed.protocol !== "https:") {
        throw new DeliveryConfigError(`L'URL ${label} Aramex doit utiliser HTTPS.`);
      }
      return base;
    };

    const [shippingFallback, trackingFallback, rateFallback] = options.sandbox
      ? [SANDBOX_SHIPPING_BASE_URL, SANDBOX_TRACKING_BASE_URL, SANDBOX_RATE_BASE_URL]
      : [PRODUCTION_SHIPPING_BASE_URL, PRODUCTION_TRACKING_BASE_URL, PRODUCTION_RATE_BASE_URL];

    this.bases = {
      shipping: normalizeBase(options.shippingBaseUrl, shippingFallback, "d'expédition"),
      tracking: normalizeBase(options.trackingBaseUrl, trackingFallback, "de suivi"),
      rate: normalizeBase(options.rateBaseUrl, rateFallback, "de tarification"),
    };

    this.clientInfo = {
      UserName: credentials.userName,
      Password: credentials.password,
      AccountNumber: credentials.accountNumber,
      AccountPin: credentials.accountPin,
      AccountEntity: credentials.accountEntity,
      AccountCountryCode: credentials.accountCountryCode.toUpperCase(),
      Version: "1.0",
      Source: this.source,
    };
  }

  /**
   * POSTs `payload` (merged with `ClientInfo`) as JSON to
   * `<base>/<endpoint>` and returns the parsed body. Throws a typed
   * DeliveryProviderError for every failure mode, including an HTTP-200
   * body of `{ HasErrors: true, Notifications: [...] }`.
   *
   * `endpoint` is the trailing service path, e.g.
   * `"Service_1_0.svc/json/CreateShipments"`.
   */
  async post(service: AramexService, endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
    const base = this.bases[service];
    let host: string;
    try {
      host = new URL(base).hostname;
      await assertPublicHost(host);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new DeliveryConfigError("L'hôte Aramex configuré n'est pas autorisé.");
      }
      throw error;
    }

    const url = `${base}/${endpoint.replace(/^\/+/, "")}`;
    const body = JSON.stringify({ ClientInfo: this.clientInfo, ...payload });

    let lastWasRetriable = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new DeliveryTimeoutError("Aramex n'a pas répondu à temps.");
        }
        lastWasRetriable = true;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DeliveryUnavailableError("Impossible de joindre Aramex.");
      }
      clearTimeout(timer);

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES - 1) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
          lastWasRetriable = true;
          continue;
        }
        throw errorForStatus(response.status);
      }
      if (!response.ok) {
        throw errorForStatus(response.status);
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new DeliveryMalformedResponseError("Réponse illisible reçue d'Aramex.");
      }
      assertNoApiError(parsed);
      return parsed;
    }
    throw lastWasRetriable
      ? new DeliveryUnavailableError("Impossible de joindre Aramex.")
      : new DeliveryUnavailableError("Aramex a retourné une réponse inattendue.");
  }
}

/**
 * Aramex reports application failures with HTTP 200 + `{ HasErrors: true,
 * Notifications: [ { Code, Message } ] }`. A `HasErrors: false` (or
 * absent) response is left alone even if `Notifications` carries
 * informational entries.
 */
export function assertNoApiError(parsed: unknown): void {
  if (parsed === null || typeof parsed !== "object") return;
  const env = aramexEnvelopeSchema.safeParse(parsed);
  if (!env.success) return;
  if (env.data.HasErrors === true) {
    throw errorForNotifications(env.data.Notifications ?? []);
  }
}
