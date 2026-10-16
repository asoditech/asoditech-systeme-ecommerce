import "server-only";

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

/**
 * Sendit error normalization (pure). Maps the HTTP statuses documented in
 * the Swagger export to the shared typed errors with safe French messages.
 * NEVER interpolates a response body, URL, token or credential.
 *
 * NOTE: 250 / 251 / 252 are documented as response codes on create/update.
 * They sit inside the 2xx range, so the client (./client.ts) checks them
 * BEFORE `response.ok` and also honours `success === false` in the envelope.
 */

/** Shown when a parcel creation was SENT but its outcome is unknown. */
export const SENDIT_OUTCOME_UNKNOWN_MESSAGE =
  "Sendit n'a pas confirmé la création du colis (pas de réponse, erreur serveur ou réponse illisible). Le colis a peut-être été créé : vérifiez sur le portail Sendit avant toute nouvelle tentative.";

export const SENDIT_ERROR_MESSAGES = {
  250: "Sendit : le champ produits est incorrect !",
  251: "Sendit : certains produits indiqués n'existent pas.",
  252: "Sendit : la quantité sélectionnée de certains produits n'est pas suffisante.",
  401: "Authentification refusée par Sendit — vérifiez la clé publique et la clé secrète.",
  403: "Sendit : vous n'avez pas la permission d'effectuer cette opération.",
  404: "Sendit : ressource introuvable.",
  422: "Sendit a refusé les données envoyées (données invalides).",
  500: "Sendit est momentanément indisponible (erreur serveur).",
} as const;

export const SENDIT_DOCUMENTED_ERROR_STATUSES = [250, 251, 252, 401, 403, 404, 422, 500] as const;

export function isSenditDocumentedErrorStatus(status: number): boolean {
  return (SENDIT_DOCUMENTED_ERROR_STATUSES as readonly number[]).includes(status);
}

export interface SenditErrorContext {
  /** Set for a non-idempotent request (parcel creation) that was actually
   * sent: a 5xx then means the outcome is unknown (repo policy — see
   * DeliveryOutcomeUnknownError), never a plain failure. */
  nonIdempotent?: boolean;
}

/** Maps an HTTP status (documented Sendit codes first, then generic HTTP
 * classes) to a typed error. Never called with the response body. */
export function errorForSenditStatus(status: number, ctx: SenditErrorContext = {}): DeliveryProviderError {
  switch (status) {
    case 400:
      // Generic HTTP semantics (not in the Sendit doc): a definite refusal.
      return new DeliveryConfigError("Sendit a refusé la requête (données incorrectes). Vérifiez la commande et la configuration.");
    case 250:
    case 251:
    case 252:
    case 422:
      return new DeliveryConfigError(SENDIT_ERROR_MESSAGES[status]);
    case 401:
      return new DeliveryAuthError(SENDIT_ERROR_MESSAGES[401]);
    case 403:
      return new DeliveryPermissionError(SENDIT_ERROR_MESSAGES[403]);
    case 404:
      return new DeliveryNotFoundError(SENDIT_ERROR_MESSAGES[404]);
  }
  if (status === 429) {
    // Generic HTTP semantics — Sendit documents no rate limit.
    return new DeliveryRateLimitError("Sendit a limité le nombre de requêtes. Réessayez plus tard.");
  }
  if (status >= 500) {
    if (ctx.nonIdempotent) {
      return new DeliveryOutcomeUnknownError(
        "Sendit a répondu par une erreur serveur : le colis a peut-être été créé. Vérifiez le portail Sendit avant de réessayer."
      );
    }
    return new DeliveryUnavailableError(SENDIT_ERROR_MESSAGES[500]);
  }
  return new DeliveryUnavailableError("Sendit a retourné une réponse inattendue.");
}

/**
 * Sanitizes a Sendit server-authored `message` before it is shown: redacts
 * any value in `secrets` (credentials, token), masks long token-like runs,
 * strips URLs, caps length.
 */
export function sanitizeSenditMessage(message: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = message;
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join("«masqué»");
  }
  out = out.replace(/https?:\/\/\S+/gi, "«lien masqué»");
  out = out.replace(/\b[A-Za-z0-9_.-]{20,}\b/g, "«masqué»");
  out = out.trim();
  return out.length > 240 ? out.slice(0, 240) + "…" : out;
}

/**
 * `success: false` in a 2xx answer to POST /deliveries. The official spec
 * (https://app.sendit.ma/docs/api-docs.json, read 2026-10-16) documents for
 * creation only 200 (`NewColisDetail`, every example `success: "true"`),
 * 250/251/252, 422, 403 and 500 — no `success: false` body and no example
 * of one. So nothing proves the parcel was NOT created: outcome unknown
 * (« à vérifier »), with Sendit's own (sanitized) message for the operator.
 */
export function senditUnconfirmedCreateRefusal(
  message: string | null | undefined,
  secrets: readonly (string | null | undefined)[] = []
): DeliveryOutcomeUnknownError {
  const detail = message ? sanitizeSenditMessage(message, secrets) : "";
  return new DeliveryOutcomeUnknownError(
    `Sendit a répondu « échec » sans confirmer que le colis n'a pas été créé${detail ? ` (${detail})` : ""}. Le colis a peut-être été créé : vérifiez sur le portail Sendit avant toute nouvelle tentative.`
  );
}

/** Error for an envelope with `success: false`. */
export function errorForSenditEnvelope(
  message: string | null | undefined,
  secrets: readonly (string | null | undefined)[] = []
): DeliveryProviderError {
  const detail = message ? sanitizeSenditMessage(message, secrets) : "";
  return new DeliveryUnavailableError(
    detail ? `Sendit a refusé la requête : ${detail}` : "Sendit a retourné une erreur pour cette requête."
  );
}
