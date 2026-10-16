import "server-only";

import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryNotFoundError,
  DeliveryProviderError,
  DeliveryRateLimitError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";

/**
 * Ameex HTTP status → typed delivery error. Fixed French strings only: a
 * non-2xx body is NEVER read or echoed, and no message ever interpolates a
 * URL, header, or credential. (Business refusals arrive as HTTP 200 +
 * `api.type: "error"` and are handled by mapper.ts `assertAmeexEnvelope`,
 * which never echoes Ameex's free-text `msg` either.)
 */
export function errorForStatus(status: number): DeliveryProviderError {
  if (status === 401 || status === 403) {
    return new DeliveryAuthError(
      "Authentification refusée par Ameex — vérifiez l'identifiant API (C-Api-Id) et la clé API (C-Api-Key)."
    );
  }
  if (status === 404) {
    return new DeliveryNotFoundError("Ressource introuvable chez Ameex.");
  }
  if (status === 429) {
    return new DeliveryRateLimitError("Ameex a limité le nombre de requêtes (60 par minute). Réessayez plus tard.");
  }
  if (status >= 500) {
    return new DeliveryUnavailableError("Ameex est momentanément indisponible.");
  }
  if (status === 400 || status === 422) {
    return new DeliveryConfigError("Ameex a refusé la requête : données invalides ou incomplètes.");
  }
  return new DeliveryUnavailableError("Ameex a retourné une réponse inattendue.");
}

export const AMEEX_OUTCOME_UNKNOWN_MESSAGE =
  "Ameex n'a pas confirmé la requête (pas de réponse ou erreur serveur). L'action a peut-être été effectuée : vérifiez sur le portail Ameex avant toute nouvelle tentative.";

export const AMEEX_LOCAL_RATE_LIMIT_MESSAGE =
  "Limite de 60 requêtes par minute vers Ameex atteinte. Réessayez dans un instant.";
