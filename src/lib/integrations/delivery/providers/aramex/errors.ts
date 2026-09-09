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
 * Aramex-specific error normalization. Every network / parsing / API
 * failure inside this adapter becomes one of the shared
 * DeliveryProviderError subclasses — never a raw fetch/DOMException/Zod
 * error, and never a message that interpolates a credential or the raw
 * response body beyond Aramex's own (sanitised) notification text.
 *
 * See docs/adr/0028-aramex-integration.md.
 */

function sanitize(message: string): string {
  const out = message.trim().replace(/\b[A-Za-z0-9_-]{20,}\b/g, "«masqué»");
  return out.length > 240 ? out.slice(0, 240) + "…" : out;
}

/** Aramex `Notifications` entries — `{ Code, Message }`. Maps the codes /
 * message substrings that are safe to act on to a typed error; everything
 * else surfaces Aramex's own sanitised message as a generic unavailable
 * error. `notifications` is the already-parsed array. */
export function errorForNotifications(
  notifications: { Code?: string | number; Message?: string }[]
): DeliveryProviderError {
  const messages = notifications
    .map((n) => n.Message?.trim())
    .filter((m): m is string => Boolean(m));
  const joined = messages.join(" · ");
  const lower = joined.toLowerCase();

  if (
    lower.includes("username") ||
    lower.includes("password") ||
    lower.includes("account number") ||
    lower.includes("accountpin") ||
    lower.includes("account pin") ||
    lower.includes("not authorized") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return new DeliveryAuthError(
      "Authentification refusée par Aramex — vérifiez le nom d'utilisateur, le mot de passe, le numéro de compte et le code PIN."
    );
  }
  if (
    lower.includes("entity") ||
    lower.includes("country code") ||
    lower.includes("product group") ||
    lower.includes("product type") ||
    lower.includes("payment type") ||
    lower.includes("invalid") ||
    lower.includes("required")
  ) {
    return new DeliveryConfigError(
      joined
        ? `Aramex a rejeté la requête : ${sanitize(joined)}. Vérifiez la configuration du connecteur (adresse d'expédition, groupe/type de produit).`
        : "Aramex a rejeté la configuration du connecteur."
    );
  }
  if (lower.includes("not found") || lower.includes("no waybill") || lower.includes("does not exist")) {
    return new DeliveryNotFoundError("Envoi introuvable chez Aramex.");
  }

  return new DeliveryUnavailableError(
    joined ? `Aramex a refusé la requête : ${sanitize(joined)}` : "Aramex a retourné une erreur pour cette requête."
  );
}

/** Maps a non-2xx HTTP status from Aramex to a typed error. Never called
 * with the response body. */
export function errorForStatus(status: number): DeliveryProviderError {
  if (status === 401 || status === 403) {
    return new DeliveryAuthError(
      "Authentification refusée par Aramex — vérifiez les identifiants du compte API."
    );
  }
  if (status === 404) {
    return new DeliveryNotFoundError("Point de terminaison Aramex introuvable — vérifiez l'URL du service.");
  }
  if (status === 429) {
    return new DeliveryRateLimitError("Aramex a limité le nombre de requêtes. Réessayez plus tard.");
  }
  if (status >= 500) {
    return new DeliveryUnavailableError("Aramex est momentanément indisponible.");
  }
  return new DeliveryUnavailableError("Aramex a retourné une réponse inattendue.");
}
