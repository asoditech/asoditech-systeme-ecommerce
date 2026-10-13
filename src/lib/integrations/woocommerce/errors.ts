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

/**
 * A 404. `remoteCode` is WooCommerce's own error slug when the body carried a
 * valid one (same strict pattern as WooCommerceApiError) — it is what tells
 * « this product id does not exist » (`woocommerce_rest_product_invalid_id`)
 * apart from a 404 that only means a wrong store URL or a disabled REST API
 * (`rest_no_route`, an HTML page…). Never part of `message`.
 */
export class WooCommerceNotFoundError extends WooCommerceError {
  readonly code = "NOT_FOUND";
  constructor(
    message: string,
    readonly remoteCode?: string
  ) {
    super(message);
  }
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

/**
 * A 4xx the store answered with (other than 401/403/404/429, which keep
 * their own types): WooCommerce rejected the request itself — duplicate
 * SKU, image it could not download, invalid field… Carries the HTTP status
 * and WooCommerce's own error slug (`remoteCode`, validated against a strict
 * slug pattern) so a caller can diagnose it. `remoteMessage` is WooCommerce's
 * text, bounded and stripped of markup — kept for diagnosis only, never put
 * into `message` (this file's header rule) nor logged.
 */
export class WooCommerceApiError extends WooCommerceError {
  readonly code = "API_ERROR";
  constructor(
    message: string,
    readonly status: number,
    readonly remoteCode: string | undefined,
    readonly remoteMessage: string | undefined
  ) {
    super(message);
  }
}

/** WooCommerce error slugs are short snake_case identifiers; anything else is not trusted as one. */
const REMOTE_CODE_PATTERN = /^[a-z0-9_.:-]{1,64}$/i;
const REMOTE_MESSAGE_MAX = 200;

/** WooCommerce's own slugs for a SKU it refuses — `product_invalid_sku` is "Invalid or duplicated SKU." (WC_Data_Exception from set_sku, products and variations alike). */
const SKU_REJECTED_CODES = new Set(["product_invalid_sku", "woocommerce_rest_product_sku_already_exists"]);
/** Slugs WooCommerce returns when it cannot download / import an image URL it was given. */
const IMAGE_REJECTED_CODES = new Set([
  "woocommerce_product_image_upload_error",
  "woocommerce_rest_invalid_remote_image_url",
  "woocommerce_rest_invalid_image",
]);

export const WOOCOMMERCE_SKU_REJECTED_MESSAGE = "SKU déjà utilisé sur la boutique.";
export const WOOCOMMERCE_IMAGE_REJECTED_MESSAGE =
  "Image inaccessible pour la boutique. Vérifiez que l’URL est publique et que l’image peut être téléchargée par WooCommerce.";

function sanitizeRemoteMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > REMOTE_MESSAGE_MAX ? `${text.slice(0, REMOTE_MESSAGE_MAX)}…` : text;
}

/**
 * Typed error for a 4xx WooCommerce answered with (see WooCommerceApiError),
 * from its already-parsed body — `undefined` when the body was empty or not
 * JSON. The user-facing message is built only from our own French text, the
 * HTTP status and the validated slug, never from WooCommerce's free text.
 */
export function apiErrorForResponse(status: number, body: unknown): WooCommerceApiError {
  const record = body && typeof body === "object" ? (body as { code?: unknown; message?: unknown }) : {};
  const remoteCode =
    typeof record.code === "string" && REMOTE_CODE_PATTERN.test(record.code) ? record.code : undefined;
  const remoteMessage = sanitizeRemoteMessage(record.message);

  let message: string;
  if (remoteCode && SKU_REJECTED_CODES.has(remoteCode)) {
    message = WOOCOMMERCE_SKU_REJECTED_MESSAGE;
  } else if (remoteCode && IMAGE_REJECTED_CODES.has(remoteCode)) {
    message = WOOCOMMERCE_IMAGE_REJECTED_MESSAGE;
  } else {
    message = `La boutique WooCommerce a refusé la requête (HTTP ${status}${remoteCode ? `, code « ${remoteCode} »` : ""}).`;
  }
  return new WooCommerceApiError(message, status, remoteCode, remoteMessage);
}

/** A 404 with WooCommerce's slug kept only when it is a valid one (see WooCommerceNotFoundError). */
export function notFoundErrorForBody(body: unknown): WooCommerceNotFoundError {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return new WooCommerceNotFoundError(
    "Ressource introuvable sur la boutique WooCommerce — vérifiez l'URL de la boutique.",
    typeof code === "string" && REMOTE_CODE_PATTERN.test(code) ? code : undefined
  );
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
