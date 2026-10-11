import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STOCK_OVERRIDE_TOKEN_TTL_MS,
  signStockOverrideToken,
  verifyStockOverrideToken,
} from "@/lib/stock-override-token";

/** P2 — the signed shortage token: tamper-proof, bound, expiring, never signed with a weak secret. */

const SECRET = "test-secret-for-stock-override-0000000000";
const OTHER_SECRET = "another-secret-for-stock-override-111111";
const NOW = 1_800_000_000_000;
const ROWS = [{ rowKey: "wh1|v:var1", requested: 3, onHand: 1, reserved: 0, acceptedOvercommit: 2 }];
const expected = { orderId: "order-1", actorUserId: "user-1" };
const sign = (over: Partial<Parameters<typeof signStockOverrideToken>[0]> = {}, secret = SECRET, now = NOW) =>
  signStockOverrideToken({ orderId: "order-1", actorUserId: "user-1", rows: ROWS, ...over }, secret, now);

/** Re-signs an arbitrary payload with the real secret — to prove the SCHEMA (not just the HMAC) rejects it. */
function forge(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update("stock-override.v1." + encoded).digest("hex")}`;
}

describe("stock override token", () => {
  it("round-trips: a token verifies for its own order and actor, before expiry", () => {
    const check = verifyStockOverrideToken(sign(), expected, SECRET, NOW + 1000);
    expect(check).toEqual({
      ok: true,
      payload: { v: 1, orderId: "order-1", actorUserId: "user-1", exp: NOW + STOCK_OVERRIDE_TOKEN_TTL_MS, rows: ROWS },
    });
  });

  it("any change to the payload or the signature is rejected", () => {
    const token = sign();
    const [encoded, sig] = token.split(".");
    const flippedPayload = `${encoded!.slice(0, -2)}${encoded!.endsWith("A") ? "B" : "A"}${encoded!.slice(-1)}.${sig}`;
    const flippedSig = `${encoded}.${sig!.slice(0, -1)}${sig!.endsWith("0") ? "1" : "0"}`;
    expect(verifyStockOverrideToken(flippedPayload, expected, SECRET, NOW).ok).toBe(false);
    expect(verifyStockOverrideToken(flippedSig, expected, SECRET, NOW)).toEqual({ ok: false, reason: "signature" });
    expect(verifyStockOverrideToken(`${encoded}.NOT-HEX`, expected, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStockOverrideToken(`${encoded}`, expected, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStockOverrideToken("x".repeat(20_000), expected, SECRET, NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyStockOverrideToken(undefined, expected, SECRET, NOW).ok).toBe(false);
    expect(verifyStockOverrideToken(42, expected, SECRET, NOW).ok).toBe(false);
  });

  it("strict payload: unknown keys, wrong version, bad numbers are rejected even when correctly signed", () => {
    const base = { v: 1, orderId: "order-1", actorUserId: "user-1", exp: NOW + 60_000, rows: ROWS };
    for (const bad of [
      { ...base, extra: true },
      { ...base, v: 2 },
      { ...base, rows: [] },
      { ...base, rows: [{ ...ROWS[0], requested: 0 }] },
      { ...base, rows: [{ ...ROWS[0], acceptedOvercommit: -1 }] },
      { ...base, rows: [{ ...ROWS[0], reserved: 1.5 }] },
      { ...base, rows: [{ ...ROWS[0], injected: "x" }] },
    ]) {
      expect(verifyStockOverrideToken(forge(bad), expected, SECRET, NOW), JSON.stringify(bad)).toEqual({ ok: false, reason: "malformed" });
    }
    expect(verifyStockOverrideToken(forge(base), expected, SECRET, NOW).ok).toBe(true);
  });

  it("expired, other order, other actor → rejected", () => {
    const token = sign();
    expect(verifyStockOverrideToken(token, expected, SECRET, NOW + STOCK_OVERRIDE_TOKEN_TTL_MS)).toEqual({ ok: false, reason: "expired" });
    expect(verifyStockOverrideToken(token, { ...expected, orderId: "order-2" }, SECRET, NOW)).toEqual({ ok: false, reason: "order" });
    expect(verifyStockOverrideToken(token, { ...expected, actorUserId: "user-2" }, SECRET, NOW)).toEqual({ ok: false, reason: "actor" });
  });

  it("secret unavailable: never signs with an empty/weak secret, never verifies against one", () => {
    expect(() => sign({}, "")).toThrow();
    expect(() => sign({}, "short")).toThrow();
    const token = sign();
    expect(verifyStockOverrideToken(token, expected, "", NOW)).toEqual({ ok: false, reason: "signature" });
    expect(verifyStockOverrideToken(token, expected, "short", NOW)).toEqual({ ok: false, reason: "signature" });
  });

  it("rotating the secret invalidates outstanding tokens", () => {
    expect(verifyStockOverrideToken(sign({}, SECRET), expected, OTHER_SECRET, NOW)).toEqual({ ok: false, reason: "signature" });
  });
});
