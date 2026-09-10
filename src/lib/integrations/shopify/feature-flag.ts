/**
 * Shopify integration kill switch (client feedback #10).
 *
 * The Shopify adapter — client, mappers, sync pipeline, webhook handlers —
 * is complete and stays in the codebase untouched. It is simply disabled
 * by default for now: users cannot start a connection, configure
 * credentials or run a manual sync, and Shopify is presented as "Bientôt
 * disponible" in the UI. Inbound webhooks for a connection that already
 * exists are deliberately left working.
 *
 * Set `SHOPIFY_INTEGRATION_ENABLED=true` to bring the integration back —
 * nothing else needs to change. The value is read from `process.env` at
 * call time so tests (and a future per-environment rollout) can flip it.
 *
 * Existing connections can still *disconnect* while disabled —
 * `disconnectIntegrationAction` is not gated — so a tenant that connected
 * Shopify before it was turned off can cleanly detach it.
 */
export function isShopifyIntegrationEnabled(): boolean {
  return process.env.SHOPIFY_INTEGRATION_ENABLED === "true";
}

/** Message shown wherever a Shopify entry point is refused while disabled. */
export const SHOPIFY_DISABLED_MESSAGE =
  "L'intégration Shopify n'est pas encore disponible.";
