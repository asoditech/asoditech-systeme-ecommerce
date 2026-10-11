import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Signed record of the stock shortages a confirmation was refused for, so an
 * authorised user's override can be limited to EXACTLY the rows that were
 * shown and accepted (P2 — stock validation at confirmation).
 *
 * The browser only carries it back: every field is re-derived and checked on
 * the server, and the stock values themselves are re-read inside the
 * confirmation transaction. The token only proves which rows, and how much
 * overcommit, the user saw and accepted.
 *
 * Format: `<base64url(JSON payload)>.<hex HMAC-SHA256>`; the HMAC covers the
 * exact payload string (no JSON re-serialisation) under a context prefix,
 * keyed by the deployment's AUTH_SECRET (same pattern as the platform unlock,
 * src/lib/auth/platform-access.ts). Rotating AUTH_SECRET invalidates every
 * outstanding token — the user simply confirms again.
 */

export const STOCK_OVERRIDE_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_LENGTH = 16_384;
const MIN_SECRET_LENGTH = 20; // same floor as src/lib/env.ts
const CONTEXT = "stock-override.v1.";
const HEX64 = /^[0-9a-f]{64}$/;

const count = z.number().int().min(0).max(1_000_000_000);
const rowSchema = z
  .object({
    rowKey: z.string().min(1).max(200),
    requested: z.number().int().min(1).max(1_000_000_000),
    onHand: z.number().int().min(-1_000_000_000).max(1_000_000_000),
    reserved: count,
    acceptedOvercommit: count,
  })
  .strict();

const payloadSchema = z
  .object({
    v: z.literal(1),
    orderId: z.string().min(1).max(64),
    actorUserId: z.string().min(1).max(64),
    exp: z.number().int().positive(),
    rows: z.array(rowSchema).min(1).max(200),
  })
  .strict();

export type StockOverrideTokenPayload = z.infer<typeof payloadSchema>;
export type StockOverrideTokenRow = z.infer<typeof rowSchema>;

export type StockOverrideTokenCheck =
  | { ok: true; payload: StockOverrideTokenPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "order" | "actor" };

function usableSecret(secret: string): boolean {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

function sign(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(CONTEXT + encoded).digest("hex");
}

/** Throws when the secret is missing/too short — never signs with a weak or default key. */
export function signStockOverrideToken(
  input: Omit<StockOverrideTokenPayload, "v" | "exp">,
  secret: string,
  now: number = Date.now()
): string {
  if (!usableSecret(secret)) throw new Error("Stock override tokens require AUTH_SECRET.");
  const payload = payloadSchema.parse({ v: 1, exp: now + STOCK_OVERRIDE_TOKEN_TTL_MS, ...input });
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Full server-side check: signature (timing-safe), strict payload, expiry, order, actor. */
export function verifyStockOverrideToken(
  token: unknown,
  expected: { orderId: string; actorUserId: string },
  secret: string,
  now: number = Date.now()
): StockOverrideTokenCheck {
  if (!usableSecret(secret)) return { ok: false, reason: "signature" };
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!HEX64.test(sig) || !/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: "malformed" };
  if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(sign(encoded, secret), "hex"))) {
    return { ok: false, reason: "signature" };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  if (parsed.data.exp <= now) return { ok: false, reason: "expired" };
  if (parsed.data.orderId !== expected.orderId) return { ok: false, reason: "order" };
  if (parsed.data.actorUserId !== expected.actorUserId) return { ok: false, reason: "actor" };
  return { ok: true, payload: parsed.data };
}
