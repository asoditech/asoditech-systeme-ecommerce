/**
 * Normalized Shopify adapter errors — mirrors
 * src/lib/integrations/woocommerce/errors.ts. Every code path that
 * touches the network or parses a GraphQL response must end up throwing
 * one of these, never a raw fetch/Zod error, which can embed request
 * details that must never reach a user-facing message or an audit log.
 * See docs/adr/0011-shopify-integration.md.
 *
 * `message` is always a safe, French, user-facing string. Never construct
 * one of these with interpolated response bodies, headers, or the raw
 * request URL.
 */
export abstract class ShopifyError extends Error {
  abstract readonly code: string;
}

export class ShopifyConfigError extends ShopifyError {
  readonly code = "CONFIG";
}

export class ShopifyAuthError extends ShopifyError {
  readonly code = "AUTH";
}

export class ShopifyPermissionError extends ShopifyError {
  readonly code = "PERMISSION";
}

export class ShopifyNotFoundError extends ShopifyError {
  readonly code = "NOT_FOUND";
}

export class ShopifyTimeoutError extends ShopifyError {
  readonly code = "TIMEOUT";
}

export class ShopifyThrottledError extends ShopifyError {
  readonly code = "THROTTLED";
}

export class ShopifyUnavailableError extends ShopifyError {
  readonly code = "UNAVAILABLE";
}

export class ShopifyMalformedResponseError extends ShopifyError {
  readonly code = "MALFORMED_RESPONSE";
}

export class ShopifyUserError extends ShopifyError {
  readonly code = "USER_ERROR";
}

/** Maps an HTTP status code to the right typed error. Never called with the response body. */
export function errorForStatus(status: number): ShopifyError {
  if (status === 401) {
    return new ShopifyAuthError("Authentification refusée par Shopify — vérifiez le jeton d'accès Admin API.");
  }
  if (status === 403) {
    return new ShopifyPermissionError(
      "Accès refusé par Shopify — vérifiez que le jeton d'accès dispose des permissions (scopes) requises."
    );
  }
  if (status === 404) {
    return new ShopifyNotFoundError("Boutique introuvable à cette adresse — vérifiez le nom de domaine Shopify.");
  }
  if (status === 429) {
    return new ShopifyThrottledError("Shopify a limité le nombre de requêtes. Réessayez dans un instant.");
  }
  if (status >= 500) {
    return new ShopifyUnavailableError("Shopify est momentanément indisponible.");
  }
  return new ShopifyUnavailableError("Shopify a retourné une réponse inattendue.");
}
