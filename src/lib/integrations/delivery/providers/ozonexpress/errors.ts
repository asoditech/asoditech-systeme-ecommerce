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
 * OzonExpress-specific error normalization. Every network / parsing / API
 * failure inside this adapter is turned into one of the shared
 * DeliveryProviderError subclasses (src/lib/integrations/delivery/errors.ts)
 * — never a raw fetch/DOMException/Zod error, and never a message that
 * interpolates a response body, the request URL (which embeds the API
 * key — see client.ts), or any credential.
 *
 * See docs/adr/0013-ozonexpress-integration.md.
 */

/**
 * OzonExpress frequently signals an application-level failure with an
 * HTTP 200 body of `{"RESULT":"ERROR","MESSAGE":"..."}` (sometimes nested
 * under an `ADD-PARCEL` key) rather than a non-2xx status. This maps the
 * few MESSAGE substrings that are safe to act on to a typed error; every
 * other message becomes a generic DeliveryUnavailableError carrying a
 * SANITIZED, non-interpolated French string.
 *
 * NOTE: the exact set of MESSAGE strings OzonExpress can return is not
 * documented — only "City Not Found" is consistently reported across the
 * community integrations this adapter was reconstructed from. Treat this
 * as a best-effort classification, not an exhaustive contract.
 */
export function errorForApiMessage(message: string): DeliveryProviderError {
  const normalized = message.toLowerCase();
  if (normalized.includes("city")) {
    return new DeliveryConfigError(
      "OzonExpress a rejeté la ville de livraison : l'identifiant de ville n'est pas reconnu. " +
        "Vérifiez la correspondance ville → identifiant OzonExpress dans la configuration du connecteur."
    );
  }
  if (
    normalized.includes("api key") ||
    normalized.includes("api-key") ||
    normalized.includes("customer") ||
    normalized.includes("unauthorized") ||
    normalized.includes("not allowed") ||
    normalized.includes("access")
  ) {
    return new DeliveryAuthError(
      "Authentification refusée par OzonExpress — vérifiez l'identifiant client et la clé API."
    );
  }
  if (normalized.includes("not found") || normalized.includes("introuvable")) {
    return new DeliveryNotFoundError("Ressource introuvable chez OzonExpress.");
  }
  return new DeliveryUnavailableError("OzonExpress a retourné une erreur pour cette requête.");
}

/** Maps a non-2xx HTTP status from OzonExpress to a typed error. Never
 * called with the response body. */
export function errorForStatus(status: number): DeliveryProviderError {
  if (status === 401 || status === 403) {
    return new DeliveryAuthError(
      "Authentification refusée par OzonExpress — vérifiez l'identifiant client et la clé API."
    );
  }
  if (status === 404) {
    return new DeliveryNotFoundError(
      "Point de terminaison OzonExpress introuvable — l'identifiant client ou la clé API est peut-être incorrect."
    );
  }
  if (status === 429) {
    return new DeliveryRateLimitError("OzonExpress a limité le nombre de requêtes. Réessayez plus tard.");
  }
  if (status >= 500) {
    return new DeliveryUnavailableError("OzonExpress est momentanément indisponible.");
  }
  return new DeliveryUnavailableError("OzonExpress a retourné une réponse inattendue.");
}
