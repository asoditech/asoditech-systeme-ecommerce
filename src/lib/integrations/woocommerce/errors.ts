/**
 * Normalized WooCommerce adapter errors. Every code path that touches the
 * network or parses an external response must end up throwing one of
 * these, never a raw fetch/DOMException/Zod error — those can embed
 * request details (and, in principle, header values) that must never reach
 * a user-facing message or an audit log. See docs/adr/0010-woocommerce-integration.md.
 *
 * `message` is always a safe, French, user-facing string. Never construct
 * one of these with interpolated response bodies, headers, or the raw
 * request URL.
 */
export abstract class WooCommerceError extends Error {
  abstract readonly code: string;
}

export class WooCommerceConfigError extends WooCommerceError {
  readonly code = "CONFIG";
}

export class WooCommerceAuthError extends WooCommerceError {
  readonly code = "AUTH";
}

export class WooCommercePermissionError extends WooCommerceError {
  readonly code = "PERMISSION";
}

export class WooCommerceNotFoundError extends WooCommerceError {
  readonly code = "NOT_FOUND";
}

export class WooCommerceTimeoutError extends WooCommerceError {
  readonly code = "TIMEOUT";
}

export class WooCommerceRateLimitError extends WooCommerceError {
  readonly code = "RATE_LIMIT";
}

export class WooCommerceUnavailableError extends WooCommerceError {
  readonly code = "UNAVAILABLE";
}

export class WooCommerceMalformedResponseError extends WooCommerceError {
  readonly code = "MALFORMED_RESPONSE";
}

/** Maps an HTTP status code from the store to the right typed error. Never called with the response body. */
export function errorForStatus(status: number): WooCommerceError {
  if (status === 401) {
    return new WooCommerceAuthError(
      "Authentification refusée par la boutique WooCommerce — vérifiez la clé et le secret API."
    );
  }
  if (status === 403) {
    return new WooCommercePermissionError(
      "Accès refusé par la boutique WooCommerce — vérifiez que la clé API dispose des permissions de lecture/écriture requises."
    );
  }
  if (status === 404) {
    return new WooCommerceNotFoundError(
      "Ressource introuvable sur la boutique WooCommerce — vérifiez l'URL de la boutique."
    );
  }
  if (status === 429) {
    return new WooCommerceRateLimitError(
      "La boutique WooCommerce a limité le nombre de requêtes. Réessayez plus tard."
    );
  }
  if (status >= 500) {
    return new WooCommerceUnavailableError("La boutique WooCommerce est momentanément indisponible.");
  }
  return new WooCommerceUnavailableError("La boutique WooCommerce a retourné une réponse inattendue.");
}
