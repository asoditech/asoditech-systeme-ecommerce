import "server-only";

import { createHash } from "node:crypto";

import { assertPublicHost, InvalidHostError } from "@/lib/integrations/shared";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryOutcomeUnknownError,
  DeliveryTimeoutError,
  DeliveryUnavailableError,
  isDefiniteCreateRefusalStatus,
} from "@/lib/integrations/delivery/errors";
import { errorForSenditStatus, SENDIT_ERROR_MESSAGES, SENDIT_OUTCOME_UNKNOWN_MESSAGE } from "./errors";
import { parseLoginResponse } from "./mapper";
import { SENDIT_BASE_URL, type SenditCredentials } from "./types";

/**
 * Thin, centralized Sendit HTTP client — the only place the adapter talks to
 * the network. Built from the official spec
 * (https://app.sendit.ma/docs/api-docs.json): base `https://app.sendit.ma/api/v1/`,
 * `POST /login { public_key, secret_key }` → `data.token`, then
 * `Authorization: Bearer <token>` (securitySchemes.bearerAuth, JWT) on every
 * other call. NOT validated against a real account yet.
 *
 * Secrets: the keys travel only in the login body, the token only in the
 * Authorization header. No error message, thrown value (no `cause`) or return
 * value ever carries a key, the token, a URL or a response body — every
 * error is a fixed French string (or an envelope message run through
 * `sanitizeSenditMessage` with the secrets redacted).
 *
 * Hardening (same posture as OzonExpress / Ameex):
 *  - fixed https base, no tenant override;
 *  - `assertPublicHost` re-run immediately before EVERY request;
 *  - timeout via AbortController, `redirect: "error"` (a redirect could
 *    forward the bearer token elsewhere).
 *
 * Token: cached in memory per credential pair, keyed by a SHA-256 of the
 * pair (never the raw keys). The lifetime is undocumented, so the cache is
 * deliberately short (SENDIT_TOKEN_TTL_MS); on a 401 the token is dropped,
 * the client logs in again ONCE and repeats the read once; a second 401 is a
 * DeliveryAuthError.
 *
 * Reads (`get`, `postRead`) retry network failures, 5xx and 429 with
 * backoff (max 3 attempts; a timeout is not retried). `createOnce` (parcel
 * creation) is ONE attempt, never retried and never re-sent after a 401.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_READ_ATTEMPTS = 3;

/** Conservative token lifetime — Sendit documents none. */
export const SENDIT_TOKEN_TTL_MS = 20 * 60_000;

/** Connection-establishment failures (undici `fetch failed` causes): the
 * request never left this server, so nothing can have happened at Sendit. */
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

/** Documented error codes that sit INSIDE the 2xx range (create/update). */
const SENDIT_IN_RANGE_ERROR_CODES: readonly number[] = [250, 251, 252];

function isInRangeErrorCode(status: number): boolean {
  return SENDIT_IN_RANGE_ERROR_CODES.includes(status);
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Process-wide token cache: sha256(publicKey \0 secretKey) → token. */
const tokenCache = new Map<string, CachedToken>();
/** In-flight logins, so concurrent calls share one POST /login. */
const pendingLogins = new Map<string, Promise<string>>();

/** Tests only. */
export function __clearSenditTokenCacheForTests(): void {
  tokenCache.clear();
  pendingLogins.clear();
}

/** Tests only — true when a token is cached for this credential pair. */
export function __hasCachedSenditTokenForTests(credentials: SenditCredentials): boolean {
  return tokenCache.has(credentialKey(credentials));
}

function credentialKey(c: SenditCredentials): string {
  return createHash("sha256").update(`${c.publicKey}\u0000${c.secretKey}`).digest("hex");
}

export interface SenditClientOptions {
  timeoutMs?: number;
  /** Tests only — retry backoff sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Tests only — clock for the token cache. */
  now?: () => number;
}

type QueryValue = string | number | undefined;

export class SenditClient {
  private readonly hostname: string;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cacheKey: string;
  private readonly credentials: SenditCredentials;

  constructor(credentials: SenditCredentials, options: SenditClientOptions = {}) {
    this.credentials = { publicKey: credentials.publicKey, secretKey: credentials.secretKey };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    const parsed = new URL(SENDIT_BASE_URL);
    if (parsed.protocol !== "https:") {
      throw new DeliveryConfigError("L'URL de base Sendit doit utiliser HTTPS.");
    }
    this.hostname = parsed.hostname;
    this.cacheKey = credentialKey(this.credentials);
  }

  /** Values redacted from any Sendit-authored message (keys + token). */
  secrets(): string[] {
    const cached = tokenCache.get(this.cacheKey)?.token;
    return [this.credentials.publicKey, this.credentials.secretKey, cached ?? ""].filter((s) => s.length >= 4);
  }

  private url(path: string, query?: Record<string, QueryValue>): string {
    const u = new URL(`${SENDIT_BASE_URL}/${path.replace(/^\/+/, "")}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  private async assertHost(): Promise<void> {
    try {
      await assertPublicHost(this.hostname);
    } catch (error) {
      if (error instanceof InvalidHostError) {
        throw new DeliveryConfigError("L'hôte Sendit n'est pas autorisé.");
      }
      throw error;
    }
  }

  private async send(url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal, redirect: "error" });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────

  /** Returns a valid bearer token, from the cache or a fresh POST /login. */
  async token(options: { force?: boolean } = {}): Promise<string> {
    if (options.force) tokenCache.delete(this.cacheKey);
    const cached = tokenCache.get(this.cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.token;
    const pending = pendingLogins.get(this.cacheKey);
    if (pending) return pending;
    const p = this.login().finally(() => pendingLogins.delete(this.cacheKey));
    pendingLogins.set(this.cacheKey, p);
    return p;
  }

  private dropToken(): void {
    tokenCache.delete(this.cacheKey);
  }

  /**
   * POST /login. Side-effect free, so network / 5xx / 429 are retried like a
   * read. 401/403 or `success: false` → DeliveryAuthError.
   */
  private async login(): Promise<string> {
    const body = JSON.stringify({ public_key: this.credentials.publicKey, secret_key: this.credentials.secretKey });
    const raw = await this.readWithRetry(this.url("login"), () => ({
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body,
    }), { isLogin: true });
    const token = parseLoginResponse(raw);
    tokenCache.set(this.cacheKey, { token, expiresAt: this.now() + SENDIT_TOKEN_TTL_MS });
    return token;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  /** Authenticated GET with retry and a single re-login on 401. */
  async get(path: string, query?: Record<string, QueryValue>): Promise<unknown> {
    const url = this.url(path, query);
    return this.authorizedRead((token) => ({
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    }), url);
  }

  /**
   * Authenticated POST WITHOUT side effect at Sendit (POST
   * /deliveries/getlabels only builds a printable file): retried like a read.
   * Never use it for creation — see `createOnce`.
   */
  async postRead(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = this.url(path);
    const payload = JSON.stringify(body);
    return this.authorizedRead((token) => ({
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: payload,
    }), url);
  }

  private async authorizedRead(
    build: (token: string) => { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
    url: string
  ): Promise<unknown> {
    let token = await this.token();
    try {
      return await this.readWithRetry(url, () => build(token));
    } catch (error) {
      if (!(error instanceof DeliveryAuthError)) throw error;
      // Token expired or revoked: log in again ONCE and repeat once.
      this.dropToken();
      token = await this.token({ force: true });
      try {
        return await this.readWithRetry(url, () => build(token));
      } catch (second) {
        if (second instanceof DeliveryAuthError) this.dropToken();
        throw second;
      }
    }
  }

  private async readWithRetry(
    url: string,
    build: () => { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
    ctx: { isLogin?: boolean } = {}
  ): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      const last = attempt === MAX_READ_ATTEMPTS - 1;
      await this.assertHost();
      let response: Response;
      try {
        response = await this.send(url, build());
      } catch (error) {
        if (isAbortError(error)) throw new DeliveryTimeoutError("Sendit n'a pas répondu à temps.");
        if (!last) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DeliveryUnavailableError("Impossible de joindre Sendit.");
      }

      if ((response.status === 429 || response.status >= 500) && !last) {
        await this.sleep(500 * 2 ** attempt);
        continue;
      }
      if (ctx.isLogin && (response.status === 401 || response.status === 403)) {
        throw new DeliveryAuthError(SENDIT_ERROR_MESSAGES[401]);
      }
      if (isInRangeErrorCode(response.status) || !response.ok) throw errorForSenditStatus(response.status);

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new DeliveryMalformedResponseError("Réponse illisible reçue de Sendit.");
      }
    }
    // Unreachable: every iteration returns, throws, or continues.
    throw new DeliveryUnavailableError("Impossible de joindre Sendit.");
  }

  // ── Creation (one attempt) ─────────────────────────────────────────────

  /**
   * POST `<base>/<path>` exactly ONCE — never retried and never re-sent
   * after a 401 (a retry after a lost answer can create a second parcel).
   *
   *  - local refusal (SSRF) / login failure → typed error, nothing sent;
   *  - connection never established → DeliveryUnavailableError (definite);
   *  - timeout, reset, any other network failure, 5xx, 429, 408, any other
   *    unexpected status, or a 2xx body that is not readable JSON →
   *    DeliveryOutcomeUnknownError;
   *  - 401/403 → DeliveryAuthError / DeliveryPermissionError (token dropped);
   *  - 400/422/250/251/252/404 → typed definite error with a fixed message.
   */
  async createOnce(path: string, body: Record<string, unknown>): Promise<unknown> {
    const token = await this.token();
    await this.assertHost();
    const url = this.url(path);
    let response: Response;
    try {
      response = await this.send(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (!isAbortError(error) && isNeverSentNetworkError(error)) {
        throw new DeliveryUnavailableError("Impossible de joindre Sendit.");
      }
      throw new DeliveryOutcomeUnknownError(SENDIT_OUTCOME_UNKNOWN_MESSAGE);
    }

    if (response.status === 401) this.dropToken();
    if (isInRangeErrorCode(response.status) || !response.ok) {
      // Only a documented / unambiguous refusal is definite. 408, 409, 5xx,
      // 429 or any other unexpected status may have created the parcel.
      if (!isDefiniteCreateRefusalStatus(response.status, SENDIT_IN_RANGE_ERROR_CODES)) {
        throw new DeliveryOutcomeUnknownError(SENDIT_OUTCOME_UNKNOWN_MESSAGE);
      }
      throw errorForSenditStatus(response.status, { nonIdempotent: true });
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new DeliveryOutcomeUnknownError(SENDIT_OUTCOME_UNKNOWN_MESSAGE);
    }
  }
}
