import "server-only";

import { createHash } from "node:crypto";

import { assertPublicHost, InvalidHostError } from "@/lib/integrations/shared";
import {
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
  DeliveryRateLimitError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
  isDefiniteCreateRefusalStatus,
} from "@/lib/integrations/delivery/errors";
import { AMEEX_LOCAL_RATE_LIMIT_MESSAGE, AMEEX_OUTCOME_UNKNOWN_MESSAGE, errorForStatus } from "./errors";
import { AMEEX_BASE_URL, type AmeexCredentials } from "./types";

/**
 * Thin, centralized Ameex HTTP client — the only place the adapter talks
 * to the network.
 *
 * Auth: the documented `C-Api-Id` / `C-Api-Key` request headers. The key is
 * therefore a secret carried in every request; this client NEVER puts a
 * header, the URL, a response body, or any credential into an error
 * message, a thrown value (no `cause` is attached), or a return value.
 * Every error is a fixed French string.
 *
 * Hardening (same posture as the OzonExpress client):
 *  - fixed `https://api.ameex.app/customer` base (no tenant override);
 *  - `assertPublicHost` re-run immediately before EVERY request (DNS
 *    rebinding);
 *  - timeout via AbortController, `redirect: "error"` (a redirect could
 *    forward the auth headers elsewhere);
 *  - in-memory sliding-window limiter: ≤ 60 calls / minute per credential
 *    (Ameex's documented limit). A call over the limit is refused LOCALLY,
 *    before anything is sent (DeliveryRateLimitError — definite).
 *
 * `get()` is for reads and retries network / 5xx / 429 with backoff (max 3
 * attempts). `postOnce()` is for side-effecting requests and NEVER retries.
 *
 * `postOnce()` still takes an explicit `encoding`. The sandbox (2026-10-16)
 * showed Ameex REFUSES a JSON body on Add (« The receiver field is
 * required. ») and accepts `application/x-www-form-urlencoded`: the adapter
 * always passes "form". Business errors come back as HTTP 200 with
 * `api.type: "error"` — that envelope is interpreted by the adapter
 * (mapper.ts `assertAmeexEnvelope`), not here. See docs/carriers/ameex.md.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_READ_ATTEMPTS = 3;

/** Documented Ameex limit. */
export const AMEEX_RATE_LIMIT_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;

/** Connection-establishment failures (undici `fetch failed` causes): the
 * request never left this server, so nothing can have happened at Ameex. */
const NEVER_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

function isNeverSentNetworkError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && NEVER_SENT_CODES.has(cause.code);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple sliding-window limiter: at most `limit` acquisitions per `windowMs`
 * per key. In-memory and per-process (a multi-instance deployment shares
 * nothing — Ameex's own 429 remains the backstop). The clock is injectable
 * for tests.
 */
export class AmeexRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number = AMEEX_RATE_LIMIT_PER_MINUTE,
    private readonly windowMs: number = RATE_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Records one call for `key` and returns true, or returns false (and
   * records nothing) when the window is full. */
  tryAcquire(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

/** Process-wide limiter shared by every client instance. */
const sharedRateLimiter = new AmeexRateLimiter();

/** Explicit, caller-chosen POST body encoding (Ameex Add needs "form"). */
export type AmeexPostEncoding = "json" | "form";

export interface AmeexClientOptions {
  timeoutMs?: number;
  /** Tests only. Defaults to the shared process-wide limiter. */
  rateLimiter?: AmeexRateLimiter;
  /** Tests only — retry backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only — still validated (https only) and SSRF-checked on every
   * call. Never wired to tenant config. */
  baseUrl?: string;
}

export class AmeexClient {
  private readonly base: string;
  private readonly hostname: string;
  private readonly timeoutMs: number;
  private readonly limiter: AmeexRateLimiter;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Hash of the credential pair — the limiter key, so the raw key is never
   * stored outside the request headers. */
  private readonly limiterKey: string;
  private readonly authHeaders: Record<string, string>;

  constructor(credentials: Pick<AmeexCredentials, "apiId" | "apiKey">, options: AmeexClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.limiter = options.rateLimiter ?? sharedRateLimiter;
    this.sleep = options.sleep ?? defaultSleep;

    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl ?? AMEEX_BASE_URL);
    } catch {
      throw new DeliveryConfigError("L'URL de base Ameex est invalide.");
    }
    if (parsed.protocol !== "https:") {
      throw new DeliveryConfigError("L'URL de base Ameex doit utiliser HTTPS.");
    }
    this.hostname = parsed.hostname;
    this.base = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;

    this.limiterKey = createHash("sha256").update(`${credentials.apiId}\u0000${credentials.apiKey}`).digest("hex");
    this.authHeaders = { "C-Api-Id": credentials.apiId, "C-Api-Key": credentials.apiKey };
  }

  private url(path: string): string {
    return `${this.base}/${path.replace(/^\/+/, "")}`;
  }

  private async assertHost(): Promise<void> {
    try {
      await assertPublicHost(this.hostname);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new DeliveryConfigError("L'hôte Ameex n'est pas autorisé.");
      }
      throw error;
    }
  }

  private acquire(): void {
    if (!this.limiter.tryAcquire(this.limiterKey)) {
      throw new DeliveryRateLimitError(AMEEX_LOCAL_RATE_LIMIT_MESSAGE);
    }
  }

  /**
   * GET `<base>/<path>` and return the parsed JSON body (as `unknown` — the
   * adapter validates the envelope and shapes itself, see mapper.ts).
   * Retries network failures, 5xx and 429 with exponential backoff, max 3
   * attempts; a timeout is not retried.
   */
  async get(path: string): Promise<unknown> {
    await this.assertHost();
    const url = this.url(path);

    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      const last = attempt === MAX_READ_ATTEMPTS - 1;
      this.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", ...this.authHeaders },
          signal: controller.signal,
          redirect: "error",
        });
      } catch (error) {
        clearTimeout(timer);
        if (isAbortError(error)) throw new DeliveryTimeoutError("Ameex n'a pas répondu à temps.");
        if (!last) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DeliveryUnavailableError("Impossible de joindre Ameex.");
      }
      clearTimeout(timer);

      if ((response.status === 429 || response.status >= 500) && !last) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw errorForStatus(response.status);

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new DeliveryMalformedResponseError("Réponse illisible reçue d'Ameex.");
      }
    }
    // Unreachable: every iteration returns, throws, or continues to a later one.
    throw new DeliveryUnavailableError("Impossible de joindre Ameex.");
  }

  /**
   * POST `<base>/<path>` exactly ONCE — never retried, because a retry after
   * a lost answer can repeat an action that actually happened (a second
   * parcel). `encoding` must be chosen explicitly by the caller (Ameex Add:
   * "form" — JSON is refused, sandbox 2026-10-16).
   *
   * Outcome classification:
   *  - local refusal (SSRF, local rate limit) → typed error, nothing sent;
   *  - ECONNREFUSED / ENOTFOUND / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT →
   *    DeliveryUnavailableError (connection never established: definite);
   *  - timeout, any other network failure (reset…), 5xx, 429, or a 2xx body
   *    that is not readable JSON → DeliveryOutcomeUnknownError (the request
   *    may have reached Ameex; 429 included because nothing documents that
   *    Ameex rejects BEFORE acting);
   *  - 401/403 → DeliveryAuthError; 400/404/422 → typed definite error;
   *    any other status (408, 409…) → DeliveryOutcomeUnknownError.
   */
  async postOnce(path: string, body: Record<string, string | number>, encoding: AmeexPostEncoding): Promise<unknown> {
    if (encoding !== "json" && encoding !== "form") {
      throw new DeliveryConfigError("Encodage de requête Ameex non spécifié.");
    }
    await this.assertHost();
    this.acquire();

    const url = this.url(path);
    const headers: Record<string, string> = { Accept: "application/json", ...this.authHeaders };
    let payload: string;
    if (encoding === "json") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      clearTimeout(timer);
      if (!isAbortError(error) && isNeverSentNetworkError(error)) {
        throw new DeliveryUnavailableError("Impossible de joindre Ameex.");
      }
      throw new DeliveryOutcomeUnknownError(AMEEX_OUTCOME_UNKNOWN_MESSAGE);
    }
    clearTimeout(timer);

    if (!response.ok) {
      // Definite only for an unambiguous refusal (400/401/403/404/422).
      // 408 (Ameex documents nothing about it, and a server can time out
      // AFTER acting), 409, 5xx, 429 or any unexpected status → unknown.
      if (!isDefiniteCreateRefusalStatus(response.status)) {
        throw new DeliveryOutcomeUnknownError(AMEEX_OUTCOME_UNKNOWN_MESSAGE);
      }
      throw errorForStatus(response.status);
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new DeliveryOutcomeUnknownError(AMEEX_OUTCOME_UNKNOWN_MESSAGE);
    }
  }
}
