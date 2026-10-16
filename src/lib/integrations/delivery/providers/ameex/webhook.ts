import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { isSandboxKey } from "./types";

/**
 * Ameex status-change webhooks.
 *
 * Documented: on every parcel status change Ameex POSTs a FORM-ENCODED body
 * with CODE, STATUT, STATUT_NAME, STATUT_COLOR, COMMENT, STATUT_S /
 * STATUT_S_NAME / STATUT_S_COLOR (sub-status, IN_PROGRESS only) and SANDBOX
 * (= 1 for sandbox events). When a webhook secret is set, the delivery
 * carries `X-Ameex-Signature: t=<timestamp>,v1=<hmac>` where
 * v1 = hex(HMAC-SHA256(secret, t + "." + rawBody)).
 *
 * OUR policies (Ameex documents none):
 *  - an UNSIGNED delivery is always rejected (no secret ⇒ false);
 *  - `t` is read as Unix SECONDS and must be within ±300 s of our clock
 *    (replay window). Every Ameex timestamp observed on the sandbox
 *    (2026-10-16: tracking `sorting_time` / `time`) is Unix seconds, which
 *    supports this reading; no real signed webhook has been received yet.
 *    If Ameex ever sent milliseconds, every delivery would fail closed.
 *  - `t` and `v1` must each appear exactly once; v1 must be 64 hex chars.
 */

export const AMEEX_SIGNATURE_HEADER = "x-ameex-signature";
export const AMEEX_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Case-insensitive header lookup over a plain record. */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return typeof value === "string" ? value : null;
  }
  return null;
}

export interface ParsedAmeexSignature {
  t: string;
  v1: string;
}

/** Parses `t=<digits>,v1=<64 hex>`; null on anything else (missing part,
 * duplicate part, wrong format). */
export function parseAmeexSignatureHeader(value: string | null | undefined): ParsedAmeexSignature | null {
  if (!value) return null;
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of value.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") {
      if (t !== null) return null;
      t = v;
    } else if (k === "v1") {
      if (v1 !== null) return null;
      v1 = v;
    }
  }
  if (t === null || v1 === null) return null;
  if (!/^\d{1,15}$/.test(t)) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(v1)) return null;
  return { t, v1: v1.toLowerCase() };
}

/** Reads and parses the signature header from a header record. */
export function readAmeexSignature(headers: Record<string, string>): ParsedAmeexSignature | null {
  return parseAmeexSignatureHeader(headerValue(headers, AMEEX_SIGNATURE_HEADER));
}

/**
 * True only for a correctly signed, fresh delivery. `rawBody` MUST be the
 * untouched request body string. Constant-time comparison.
 */
export function verifyAmeexSignature(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  nowMs: number = Date.now()
): boolean {
  if (typeof secret !== "string" || secret.length === 0) return false;
  const sig = readAmeexSignature(headers);
  if (!sig) return false;

  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - Number(sig.t)) > AMEEX_WEBHOOK_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${sig.t}.${rawBody}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(sig.v1, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export interface AmeexWebhookPayload {
  parcelCode: string;
  status: string;
  statusName: string | null;
  comment: string | null;
  /** Present only when Ameex sends a sub-status (documented: IN_PROGRESS). */
  subStatus?: { code: string; name: string | null };
  /** True when SANDBOX=1. */
  sandbox: boolean;
}

function field(params: URLSearchParams, name: string): string | null {
  const v = params.get(name);
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

/** Parses the form-encoded body. Returns null when CODE or STATUT is
 * missing/empty — such a body is not actionable. */
export function parseAmeexWebhook(rawBody: string): AmeexWebhookPayload | null {
  if (typeof rawBody !== "string") return null;
  const params = new URLSearchParams(rawBody);
  const parcelCode = field(params, "CODE");
  const status = field(params, "STATUT");
  if (!parcelCode || !status) return null;

  const payload: AmeexWebhookPayload = {
    parcelCode,
    status,
    statusName: field(params, "STATUT_NAME"),
    comment: field(params, "COMMENT"),
    sandbox: field(params, "SANDBOX") === "1",
  };
  const sub = field(params, "STATUT_S");
  if (sub) payload.subStatus = { code: sub, name: field(params, "STATUT_S_NAME") };
  return payload;
}

/** Stable per-delivery id for replay / dedupe: sha256 hex of `${t}.${rawBody}`.
 * The same signed delivery replayed yields the same id; a genuinely new
 * delivery (new `t`) yields a new one. */
export function webhookEventId(rawBody: string, t: string): string {
  return createHash("sha256").update(`${t}.${rawBody}`, "utf8").digest("hex");
}

/** A sandbox event (SANDBOX=1) must be ignored when the configured key is a
 * live (production) key. The adapter's `mapWebhookPayload` cannot see the
 * credentials, so the webhook route / service must call this. */
export function shouldIgnoreSandboxEvent(event: { sandbox: boolean }, apiKey: string): boolean {
  return event.sandbox && !isSandboxKey(apiKey);
}
