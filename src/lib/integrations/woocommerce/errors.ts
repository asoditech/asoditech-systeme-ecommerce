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

/**
 * Sharper 401/403 mapping using WooCommerce's own machine-readable error
 * `code` — a small closed vocabulary of slugs, never free text, so it is
 * safe to branch on (the slug itself is still never interpolated into the
 * user-facing message — see this file's header).
 *
 * The distinction that matters operationally: a request WooCommerce
 * received *with* credentials it rejected (`woocommerce_rest_authentication_error`)
 * vs. a request that reached WooCommerce carrying *no* credentials at all
 * (`woocommerce_rest_cannot_view` / `_cannot_create`, or an empty body) —
 * the latter is almost always the web server (LiteSpeed, Apache
 * CGI/FastCGI, common on Hostinger) silently stripping the `Authorization`
 * header before PHP sees it, not a wrong key. Telling the operator to
 * "check the key" when the key never arrived sends them in circles.
 */
export function authErrorForCode(status: number, code: string | undefined): WooCommerceError {
  if (code === "woocommerce_rest_authentication_error" || code === "woocommerce_rest_invalid_signature") {
    return new WooCommerceAuthError(
      "Clé ou secret API refusés par la boutique WooCommerce. Régénérez une clé avec les permissions Lecture/Écriture dans WooCommerce → Réglages → Avancé → API REST, puis reconnectez."
    );
  }
  if (
    status === 401 &&
    (code === undefined || code === "woocommerce_rest_cannot_view" || code === "woocommerce_rest_cannot_create")
  ) {
    return new WooCommerceAuthError(
      "La boutique WooCommerce n'a pas reçu les identifiants API — le serveur web ne transmet pas l'en-tête « Authorization » à WooCommerce (fréquent avec LiteSpeed / Hostinger). Ajoutez la règle de réécriture correspondante dans le .htaccess de la boutique, puis réessayez."
    );
  }
  if (status === 403) {
    return new WooCommercePermissionError(
      "Accès refusé par la boutique WooCommerce — la clé API n'a pas les permissions Lecture/Écriture, ou l'utilisateur associé à la clé n'est pas administrateur / responsable de boutique."
    );
  }
  return errorForStatus(status);
}
