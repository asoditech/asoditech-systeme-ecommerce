# ADR 0004 — Integration architecture

## Status
Accepted (2026-08-21). **Superseded for WooCommerce and Shopify
specifically** by `docs/adr/0010-woocommerce-integration.md` (Phase 20)
and `docs/adr/0011-shopify-integration.md` (Phase 21), which implement
real adapters — this document remains the source of truth for every
other still-scaffolded provider (ad platforms, WhatsApp, email, Google
Sheets, AI provider) and for the parts of the shared connection model
(the `Integration`/`SyncRun` registry, credential encryption) 0010/0011
reuse rather than replace.

## Context
The system must eventually connect to WooCommerce, Shopify, delivery
providers, ad platforms (Meta/Google/TikTok), WhatsApp, email, Google
Sheets, and an AI provider. The brief is explicit: build the boundary, not
fake integrations. No adapter for any of these external systems is
implemented in this phase.

## Decision

### The `Integration` model is the connection registry
One row per `IntegrationProvider` enum value
(`WOOCOMMERCE` / `SHOPIFY` / `META_ADS` / `GOOGLE_ADS` / `TIKTOK_ADS` /
`WHATSAPP` / `EMAIL` / `GOOGLE_SHEETS` / `AI_PROVIDER`), tracking
`status` (`DECONNECTE` / `CONNECTE` / `ERREUR`), non-secret `config`
(JSON), `credentialsEncrypted`, `capabilities`, `lastSyncAt`, `lastError`.
`SyncRun` records individual synchronization attempts (direction, status,
items processed/failed) — the schema is ready for a real sync engine, but
no sync engine exists yet.

### Credential encryption
`src/lib/crypto.ts` implements AES-256-GCM encryption for
`Integration.credentialsEncrypted`, keyed by `INTEGRATION_ENCRYPTION_KEY`
(a 32-byte key, base64-encoded, validated at startup by `src/lib/env.ts`).
This is distinct from password hashing (`bcryptjs`, one-way) — integration
credentials must be *decryptable* (the app needs the plaintext API key to
call the external API), passwords must not be. Never use `crypto.ts` for
anything password-shaped; never use `bcryptjs` for anything that needs to
be read back.

### What's actually built vs. what's a boundary
**WooCommerce** and **Shopify** both now have real adapters — a real
"Tester la connexion" that performs an authenticated request, and real
product/order/customer/stock synchronization — see
`docs/adr/0010-woocommerce-integration.md` and
`docs/adr/0011-shopify-integration.md`, which supersede this section for
those two providers specifically.

The other seven providers (Meta Ads, Google Ads, TikTok Ads, WhatsApp,
Email, Google Sheets, AI Provider) still only get `connectIntegrationAction`
(store a site URL and encrypted API key/secret — status lands on
`CONFIGURE`, never implying a verified connection; no API call, no
verification, no import/export) and are shown on the Integrations page as
planned/unavailable beyond that, with no configuration UI — building
credential forms for seven providers with no adapter behind them would be
pure UI surface with no function.

### Product/order mapping readiness
`Product.source` / `Product.externalId` and `Order.source` /
`Order.externalId` exist so an external import can write into a
`Product`/`Order` row that's traceable back to its external origin,
without ever needing external-platform-specific fields on the core
models. The WooCommerce and Shopify adapters now do exactly this — see
`docs/adr/0010-woocommerce-integration.md` and
`docs/adr/0011-shopify-integration.md`. The remaining providers in this
system (ad platforms, WhatsApp, email, Google Sheets, AI) have no
product/order concept of their own to map.

## Audit addendum (2026-08-21 A–G pre-integration hardening)
`connectIntegrationAction` previously returned the full `Integration` record
to the client, including `credentialsEncrypted`. Even though the value is
ciphertext (not plaintext), it must never cross the Server→Client boundary
at all — the client has no legitimate use for it, and shipping ciphertext
unnecessarily widens the attack surface for offline brute-force if the
encryption key is ever compromised elsewhere. Fixed: the action now returns
only `{ id }}`.

**Open finding, not fixed this pass** (flagged for a deliberate future
decision rather than silently resolved): this ADR's own "must not be
blurred" warning above is only enforced in body copy today. The
`IntegrationStatus` enum has no "configured but not verified" value distinct
from `CONNECTE`, so the Integrations page badge renders a plain green
"Connecté" the moment credentials are saved — before any real connectivity
check exists. A future enum value (e.g. `CONFIGURE_NON_VERIFIE`) would let
the badge itself carry the distinction this ADR already commits to, instead
of relying on adjacent page text. Deferred rather than changed now because
it touches a shared enum and every status-label call site — a schema-level
decision, not a trivial fix.

## Explicitly deferred
- **Any real API adapter for the remaining providers** (Meta/Google/TikTok
  ad reporting clients, WhatsApp Business API, email sending, Google
  Sheets import/export, an LLM provider client). Building one without a
  live account to test against would produce untested, likely-broken code
  — worse than not building it. WooCommerce and Shopify are no longer in
  this list — see `docs/adr/0010-woocommerce-integration.md` and
  `docs/adr/0011-shopify-integration.md`.
- **Webhook receivers for the remaining providers.** WooCommerce's
  order.created/order.updated and Shopify's orders/create,
  orders/updated, orders/cancelled, refunds/create webhooks are now
  implemented with signature verification — see
  `docs/adr/0010-woocommerce-integration.md` and
  `docs/adr/0011-shopify-integration.md`.
- **Sync scheduling/retry policy.** `SyncRun` has the fields for it
  (`itemsProcessed`, `itemsFailed`, `errorSummary`) but no scheduler calls
  it.
- **Licensing check-in with the Control Center.** See
  `docs/adr/0002-domain-model.md`'s multi-tenancy section — this is a
  distinct future integration (this system as a licensed *client* of the
  Control Center's API, not a provider this system connects *to*).
