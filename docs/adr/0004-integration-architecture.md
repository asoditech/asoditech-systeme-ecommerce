# ADR 0004 — Integration architecture

## Status
Accepted (2026-08-21)

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
`connectIntegrationAction` (WooCommerce and Shopify only — the two
"initial planned integrations" per the brief) lets an operator store a
site URL and encrypted API key/secret. This **only stores configuration**.
It does not call the WooCommerce/Shopify API, does not verify the
credentials work, does not import or export anything. The Integrations
page UI says this explicitly ("aucune synchronisation automatique n'est
encore active"). Marking `status = CONNECTE` here means "credentials are
configured," not "verified live connection" — this distinction matters and
must not be blurred in future UI copy.

The other seven providers (Meta Ads, Google Ads, TikTok Ads, WhatsApp,
Email, Google Sheets, AI Provider) are shown on the Integrations page as
planned/unavailable, with no configuration UI — building credential forms
for seven providers with no adapter behind them would be pure UI surface
with no function.

### Product/order mapping readiness
`Product.source` / `Product.externalId` and `Order.source` /
`Order.externalId` exist so a future WooCommerce/Shopify import can write
into a `Product`/`Order` row that's traceable back to its external origin,
without ever needing external-platform-specific fields on the core models.
The mapping/transform logic itself (an adapter layer translating a
WooCommerce product payload into a `Product.create()` call) does not exist
yet — there's no live connection to map from.

## Explicitly deferred
- **Any real API adapter** (WooCommerce REST client, Shopify Admin API
  client, Meta/Google/TikTok ad reporting clients, WhatsApp Business API,
  email sending, Google Sheets import/export, an LLM provider client).
  Building one without a live account to test against would produce
  untested, likely-broken code — worse than not building it.
- **Webhook receivers** for any provider (e.g. WooCommerce order-created
  webhooks). The brief requires webhook signature verification once these
  exist; there's nothing to verify yet.
- **Sync scheduling/retry policy.** `SyncRun` has the fields for it
  (`itemsProcessed`, `itemsFailed`, `errorSummary`) but no scheduler calls
  it.
- **Licensing check-in with the Control Center.** See
  `docs/adr/0002-domain-model.md`'s multi-tenancy section — this is a
  distinct future integration (this system as a licensed *client* of the
  Control Center's API, not a provider this system connects *to*).
