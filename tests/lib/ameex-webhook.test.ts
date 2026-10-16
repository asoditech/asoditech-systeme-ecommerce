import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AMEEX_WEBHOOK_TOLERANCE_SECONDS,
  parseAmeexSignatureHeader,
  parseAmeexWebhook,
  shouldIgnoreSandboxEvent,
  verifyAmeexSignature,
  webhookEventId,
} from "@/lib/integrations/delivery/providers/ameex/webhook";
import {
  ameexWebhookBody,
  FAKE_AMEEX_LIVE_KEY,
  FAKE_AMEEX_SANDBOX_KEY,
  FAKE_AMEEX_WEBHOOK_SECRET,
  signAmeex,
} from "../helpers/fake-ameex";

const NOW_MS = 1_800_000_000_000;
const T = Math.floor(NOW_MS / 1000);
const body = ameexWebhookBody({
  CODE: "SBX-FAKE0001",
  STATUT: "DELIVERED",
  STATUT_NAME: "Livré",
  STATUT_COLOR: "#00aa00",
  COMMENT: "Remis au client",
});

function headers(sig: string, name = "X-Ameex-Signature"): Record<string, string> {
  return { [name]: sig, "content-type": "application/x-www-form-urlencoded" };
}

describe("verifyAmeexSignature", () => {
  it("accepts a valid signature over the raw body", () => {
    expect(verifyAmeexSignature(body, headers(signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T)), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(true);
  });

  it("finds the header case-insensitively", () => {
    const sig = signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T);
    for (const name of ["x-ameex-signature", "X-AMEEX-SIGNATURE", "X-Ameex-Signature"]) {
      expect(verifyAmeexSignature(body, headers(sig, name), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(true);
    }
  });

  it("tolerates spaces and part order", () => {
    const sig = signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T);
    const [t, v1] = sig.split(",");
    expect(verifyAmeexSignature(body, headers(` ${v1} , ${t} `), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T);
    const tampered = body.replace("DELIVERED", "RETURNED");
    expect(verifyAmeexSignature(tampered, headers(sig), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a re-serialized body (raw body only)", () => {
    const sig = signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T);
    const reserialized = new URLSearchParams(body).toString().replace(/\+/g, "%20");
    expect(reserialized).not.toBe(body);
    expect(verifyAmeexSignature(reserialized, headers(sig), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = signAmeex(body, "another-fake-secret", T);
    expect(verifyAmeexSignature(body, headers(sig), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a tampered timestamp (t is part of the signed string)", () => {
    const sig = signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T).replace(`t=${T}`, `t=${T + 1}`);
    expect(verifyAmeexSignature(body, headers(sig), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a missing header (unsigned delivery)", () => {
    expect(verifyAmeexSignature(body, { "content-type": "application/x-www-form-urlencoded" }, FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it.each([
    "",
    "garbage",
    `t=${T}`,
    "v1=" + "a".repeat(64),
    `t=abc,v1=${"a".repeat(64)}`,
    `t=${T},v1=nothex`,
    `t=${T},v1=${"a".repeat(63)}`,
    `t=${T},t=${T},v1=${"a".repeat(64)}`,
    `t=${T},v1=${"a".repeat(64)},v1=${"b".repeat(64)}`,
    `t=-${T},v1=${"a".repeat(64)}`,
  ])("rejects a malformed header %j", (sig) => {
    expect(parseAmeexSignatureHeader(sig)).toBeNull();
    expect(verifyAmeexSignature(body, headers(sig), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it(`rejects a stale or future timestamp (> ${AMEEX_WEBHOOK_TOLERANCE_SECONDS} s)`, () => {
    for (const t of [T - 301, T + 301, T - 86_400]) {
      expect(verifyAmeexSignature(body, headers(signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, t)), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
    }
    for (const t of [T - 300, T + 300]) {
      expect(verifyAmeexSignature(body, headers(signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, t)), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(true);
    }
  });

  it("fails closed on a millisecond timestamp (unit undocumented — seconds assumed)", () => {
    expect(verifyAmeexSignature(body, headers(signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(false);
  });

  it("rejects when the configured secret is empty — even if the delivery was signed with an empty key", () => {
    const sig = signAmeex(body, "", T);
    expect(verifyAmeexSignature(body, headers(sig), "", NOW_MS)).toBe(false);
  });

  it("accepts an upper-case hex v1", () => {
    const sig = signAmeex(body, FAKE_AMEEX_WEBHOOK_SECRET, T).replace(/v1=([0-9a-f]+)/, (_m, h: string) => `v1=${h.toUpperCase()}`);
    expect(verifyAmeexSignature(body, headers(sig), FAKE_AMEEX_WEBHOOK_SECRET, NOW_MS)).toBe(true);
  });
});

describe("parseAmeexWebhook", () => {
  it("parses the documented form fields", () => {
    expect(parseAmeexWebhook(body)).toEqual({
      parcelCode: "SBX-FAKE0001",
      status: "DELIVERED",
      statusName: "Livré",
      comment: "Remis au client",
      sandbox: false,
    });
  });

  it("reads the sub-status when present", () => {
    const b = ameexWebhookBody({ CODE: "C1", STATUT: "X", STATUT_S: "IN_PROGRESS", STATUT_S_NAME: "En cours", STATUT_S_COLOR: "#ff0" });
    expect(parseAmeexWebhook(b)?.subStatus).toEqual({ code: "IN_PROGRESS", name: "En cours" });
  });

  it("flags SANDBOX=1 only", () => {
    expect(parseAmeexWebhook(ameexWebhookBody({ CODE: "C1", STATUT: "X", SANDBOX: "1" }))?.sandbox).toBe(true);
    expect(parseAmeexWebhook(ameexWebhookBody({ CODE: "C1", STATUT: "X", SANDBOX: "0" }))?.sandbox).toBe(false);
    expect(parseAmeexWebhook(ameexWebhookBody({ CODE: "C1", STATUT: "X" }))?.sandbox).toBe(false);
  });

  it.each([
    ["missing CODE", { STATUT: "DELIVERED" }],
    ["missing STATUT", { CODE: "C1" }],
    ["empty CODE", { CODE: "  ", STATUT: "DELIVERED" }],
    ["empty STATUT", { CODE: "C1", STATUT: "" }],
  ])("rejects %s", (_l, fields) => {
    expect(parseAmeexWebhook(ameexWebhookBody(fields as Record<string, string>))).toBeNull();
  });

  it("rejects a JSON body (documented encoding is form)", () => {
    expect(parseAmeexWebhook(JSON.stringify({ CODE: "C1", STATUT: "X" }))).toBeNull();
  });
});

describe("webhookEventId / shouldIgnoreSandboxEvent", () => {
  it("is sha256 hex of `${t}.${rawBody}` — stable for a replay, new for a new delivery", () => {
    const expected = createHash("sha256").update(`${T}.${body}`).digest("hex");
    expect(webhookEventId(body, String(T))).toBe(expected);
    expect(webhookEventId(body, String(T))).toBe(webhookEventId(body, String(T)));
    expect(webhookEventId(body, String(T + 1))).not.toBe(expected);
  });

  it("ignores sandbox events only when the configured key is live", () => {
    expect(shouldIgnoreSandboxEvent({ sandbox: true }, FAKE_AMEEX_LIVE_KEY)).toBe(true);
    expect(shouldIgnoreSandboxEvent({ sandbox: true }, FAKE_AMEEX_SANDBOX_KEY)).toBe(false);
    expect(shouldIgnoreSandboxEvent({ sandbox: false }, FAKE_AMEEX_LIVE_KEY)).toBe(false);
  });
});
