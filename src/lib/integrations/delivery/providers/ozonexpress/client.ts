import "server-only";

import { assertPublicHost, InvalidHostError } from "@/lib/integrations/shared";
import {
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import { errorForApiMessage, errorForStatus } from "./errors";
import { ozonExpressErrorEnvelopeSchema, type OzonExpressCredentials } from "./types";

/**
 * Thin, centralized OzonExpress HTTP client. Every network call the
 * adapter makes goes through `post()` (credentialed actions) or `get()`
 * (the un-credentialed `/cities` catalogue) — one place for the path-based
 * auth, SSRF re-validation, timeout, retry, and the "HTTP 200 that is
 * actually an error" unwrapping.
 *
 * ⚠️ Path-based credentials. OzonExpress authenticates by embedding the
 * customer id AND api key as URL path segments
 * (`/customers/{id}/{key}/<action>`), not via a header. That means the
 * request URL itself is a secret. This client therefore NEVER puts a URL
 * (or anything derived from one) into an error message, a thrown value, or
 * a return value. Errors carry either a fixed French string or, for an
 * unclassified OzonExpress `RESULT:ERROR`, OzonExpress's own MESSAGE first
 * run through `redact` (this client's own credential values) and a
 * length/token safeguard. See docs/adr/0013-ozonexpress-integration.md
 * ("Credentials").
 */

const PRODUCTION_BASE_URL = "https://api.ozonexpress.ma";
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `unknown` → number | null without ever coercing a missing / empty /
 * non-numeric value to 0. OzonExpress returns money as strings like
 * "25.00"; a genuinely absent field must stay null (never a fabricated 0 —
 * see docs/adr/0012 "Delivery cost"). */
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

export class OzonExpressClient {
  private readonly baseHost: string;
  private readonly pathPrefix: string;
  private readonly timeoutMs: number;
  /** Credential values to strip from any provider message before it is
   * surfaced — see `redact`. */
  private readonly secrets: string[];

  constructor(
    credentials: OzonExpressCredentials,
    baseUrlOverride?: string,
    options?: { timeoutMs?: number }
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.secrets = [credentials.customerId, credentials.apiKey].filter((s) => s.length >= 4);
    const base = (baseUrlOverride ?? PRODUCTION_BASE_URL).replace(/\/+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new DeliveryConfigError("L'URL de base OzonExpress configurée est invalide.");
    }
    if (parsed.protocol !== "https:") {
      throw new DeliveryConfigError("L'URL de base OzonExpress doit utiliser HTTPS.");
    }
    this.baseHost = `${parsed.protocol}//${parsed.host}`;
    // encodeURIComponent so a credential containing a slash / space can
    // never break out of its path segment.
    this.pathPrefix = `/customers/${encodeURIComponent(credentials.customerId)}/${encodeURIComponent(credentials.apiKey)}`;
  }

  /** Replaces this client's own credential values with «masqué» anywhere
   * they appear in `text`. */
  private redact = (text: string): string => {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join("«masqué»");
    }
    return out;
  };

  /**
   * POSTs `form` as multipart/form-data to `<host><prefix>/<action>` and
   * returns the parsed JSON body. Throws a typed DeliveryProviderError for
   * every failure mode, including an HTTP-200 body of
   * `{"RESULT":"ERROR","MESSAGE":...}` (flat or nested one level).
   */
  async post(action: string, form: Record<string, string>): Promise<unknown> {
    // Re-validate SSRF immediately before the call, not just at construction
    // — DNS can change between the two (rebinding). Shared logic with
    // WooCommerce/Shopify (src/lib/integrations/shared/private-ip.ts).
    let host: string;
    try {
      host = new URL(this.baseHost).hostname;
      await assertPublicHost(host);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new DeliveryConfigError("L'hôte OzonExpress configuré n'est pas autorisé.");
      }
      throw error;
    }

    const url = `${this.baseHost}${this.pathPrefix}/${action}`;
    const body = new FormData();
    for (const [key, value] of Object.entries(form)) body.append(key, value);

    let lastWasRetriable = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          body,
          headers: { Accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new DeliveryTimeoutError("OzonExpress n'a pas répondu à temps.");
        }
        // Network-level failure (DNS/TLS/refused) — retry with backoff.
        lastWasRetriable = true;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DeliveryUnavailableError("Impossible de joindre OzonExpress.");
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
        throw new DeliveryMalformedResponseError("Réponse illisible reçue d'OzonExpress.");
      }
      assertNoApiError(parsed, this.redact);
      return parsed;
    }
    // Unreachable in practice (every path above either returns or throws),
    // but keeps the type checker happy without an unsafe assertion.
    throw lastWasRetriable
      ? new DeliveryUnavailableError("Impossible de joindre OzonExpress.")
      : new DeliveryUnavailableError("OzonExpress a retourné une réponse inattendue.");
  }

  /**
   * GETs `<host>/<path>` (no credential path segments) and returns the
   * parsed JSON body. Used for `GET /cities`, the destination catalogue,
   * which the owner-provided documentation lists as an un-credentialed
   * endpoint. Same SSRF re-check, timeout, retry, and error normalization
   * as `post()`.
   */
  async get(path: string): Promise<unknown> {
    try {
      await assertPublicHost(new URL(this.baseHost).hostname);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new DeliveryConfigError("L'hôte OzonExpress configuré n'est pas autorisé.");
      }
      throw error;
    }

    const url = `${this.baseHost}/${path.replace(/^\/+/, "")}`;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new DeliveryTimeoutError("OzonExpress n'a pas répondu à temps.");
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DeliveryUnavailableError("Impossible de joindre OzonExpress.");
      }
      clearTimeout(timer);

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES - 1) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw errorForStatus(response.status);

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new DeliveryMalformedResponseError("Réponse illisible reçue d'OzonExpress.");
      }
      assertNoApiError(parsed, this.redact);
      return parsed;
    }
    throw new DeliveryUnavailableError("Impossible de joindre OzonExpress.");
  }
}

/**
 * OzonExpress signals failures with HTTP 200 + `{"RESULT":"ERROR",
 * "MESSAGE":"..."}`, either at top level or one level under an action key
 * (`CHECK_API`, `ADD-PARCEL`, `TRACKING`, …). A block whose
 * `RESULT === "SUCCESS"` (e.g. `CHECK_API` on a valid key) is left alone.
 * `errorForApiMessage` maps known MESSAGE substrings to fixed French
 * strings; anything it can't classify surfaces OzonExpress's own message,
 * first run through `redact` (this client's credential values) and a
 * length/token safeguard.
 */
export function assertNoApiError(parsed: unknown, redact?: (s: string) => string): void {
  if (parsed === null || typeof parsed !== "object") return;

  const top = ozonExpressErrorEnvelopeSchema.safeParse(parsed);
  if (top.success && top.data.RESULT?.toUpperCase() === "ERROR") {
    throw errorForApiMessage(top.data.MESSAGE ?? "", redact);
  }

  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    const nested = ozonExpressErrorEnvelopeSchema.safeParse(value);
    if (nested.success && nested.data.RESULT?.toUpperCase() === "ERROR") {
      throw errorForApiMessage(nested.data.MESSAGE ?? "", redact);
    }
  }
}
