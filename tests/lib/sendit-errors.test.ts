import { describe, expect, it } from "vitest";
import {
  errorForSenditEnvelope,
  errorForSenditStatus,
  isSenditDocumentedErrorStatus,
  sanitizeSenditMessage,
  SENDIT_DOCUMENTED_ERROR_STATUSES,
} from "@/lib/integrations/delivery/providers/sendit/errors";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryNotFoundError,
  DeliveryOutcomeUnknownError,
  DeliveryPermissionError,
  DeliveryProviderError,
  DeliveryRateLimitError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";

describe("errorForSenditStatus", () => {
  it.each([
    [250, DeliveryConfigError, "Sendit : le champ produits est incorrect !"],
    [251, DeliveryConfigError, "n'existent pas"],
    [252, DeliveryConfigError, "n'est pas suffisante"],
    [401, DeliveryAuthError, "Authentification refusée par Sendit"],
    [403, DeliveryPermissionError, "permission"],
    [404, DeliveryNotFoundError, "introuvable"],
    [422, DeliveryConfigError, "données invalides"],
    [500, DeliveryUnavailableError, "indisponible"],
  ] as const)("%i → typed error", (status, cls, text) => {
    const err = errorForSenditStatus(status);
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(DeliveryProviderError);
    expect(err.message).toContain(text);
  });

  it("covers every documented status", () => {
    expect([...SENDIT_DOCUMENTED_ERROR_STATUSES]).toEqual([250, 251, 252, 401, 403, 404, 422, 500]);
    for (const s of SENDIT_DOCUMENTED_ERROR_STATUSES) expect(isSenditDocumentedErrorStatus(s)).toBe(true);
    expect(isSenditDocumentedErrorStatus(200)).toBe(false);
  });

  it("5xx on a non-idempotent request → outcome unknown", () => {
    expect(errorForSenditStatus(500, { nonIdempotent: true })).toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(errorForSenditStatus(503, { nonIdempotent: true })).toBeInstanceOf(DeliveryOutcomeUnknownError);
    expect(errorForSenditStatus(422, { nonIdempotent: true })).toBeInstanceOf(DeliveryConfigError);
  });

  it("generic HTTP classes", () => {
    expect(errorForSenditStatus(429)).toBeInstanceOf(DeliveryRateLimitError);
    expect(errorForSenditStatus(502)).toBeInstanceOf(DeliveryUnavailableError);
    expect(errorForSenditStatus(418)).toBeInstanceOf(DeliveryUnavailableError);
  });
});

describe("message sanitization", () => {
  const secret = "pk_live_abcdefghijklmnopqrstuvwxyz";
  const token = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

  it("never echoes credentials, tokens or URLs", () => {
    const out = sanitizeSenditMessage(`clé ${secret} jeton ${token} voir https://app.x/y?t=1 sec`, ["sec-short"]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(token);
    expect(out).not.toContain("https://");
  });

  it("redacts explicitly passed short secrets", () => {
    expect(sanitizeSenditMessage("bad key s3cr3t", ["s3cr3t"])).not.toContain("s3cr3t");
  });

  it("envelope errors carry the sanitized message only", () => {
    const err = errorForSenditEnvelope(`Refusé pour ${secret}`, [secret]);
    expect(err).toBeInstanceOf(DeliveryUnavailableError);
    expect(err.message).toContain("Sendit a refusé la requête");
    expect(err.message).not.toContain(secret);
    expect(errorForSenditEnvelope(null).message).toBe("Sendit a retourné une erreur pour cette requête.");
  });

  it("caps length", () => {
    expect(sanitizeSenditMessage("mot ".repeat(200)).length).toBeLessThanOrEqual(241);
  });
});
