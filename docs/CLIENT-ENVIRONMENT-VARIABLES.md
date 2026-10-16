# Client Environment Variables Reference

Audited directly from `src/lib/env.ts` (the Zod schema every deployment is
validated against at build/boot time), `prisma.config.ts`, and every
`process.env.*` call site in `src/` and `scripts/` — nothing below is
invented. See `.env.production.example` for a ready-to-fill template and
`docs/CLIENT-DEPLOYMENT-RUNBOOK.md` for how each variable is used in
context.

**Keep this file, `.env.production.example`, and `src/lib/env.ts` in
sync.** `tests/lib/deployment-docs-coverage.test.ts` fails the build the
moment a new variable is added to `src/lib/env.ts` (or one of the other
runtime call sites this file documents) without a matching row here — see
"Keeping this document honest" at the bottom.

## Full table

| Variable | Purpose | Where to get it | Example format | Vercel environment | Secret / Public | Required / Optional |
| --- | --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Pooled Postgres connection the running app uses for every query. Must connect as the **restricted runtime role** (`scripts/provision-production-role.sql`) — not the table owner, not a superuser — or Row-Level Security enforces nothing (`docs/adr/0026-multi-tenant-rls.md`). | Supabase → Project Settings → Database → Connection string ("Transaction" pooler, port 6543), rewritten to use the restricted role's password. | `postgresql://asoditech_app:•••@db.xxxx.supabase.co:6543/postgres?schema=public&pgbouncer=true` | Production **and** Preview | Secret | **Required** |
| `DIRECT_URL` | Unpooled Postgres connection used only by `prisma migrate deploy` (runs as part of the `vercel-build` script) to execute DDL. Must be the database **owner/admin** role — the restricted runtime role above cannot run DDL. | Supabase → Project Settings → Database → Connection string ("Session"/direct, port 5432). | `postgresql://postgres:•••@db.xxxx.supabase.co:5432/postgres?schema=public` | Production **and** Preview | Secret | **Required** |
| `AUTH_SECRET` | HMAC pepper for session-token hashing (`src/lib/auth/session.ts`) and the shared token mechanism behind invitations/password resets (`src/lib/auth/tokens.ts`). Rotating it invalidates every live session. | Generate locally: `openssl rand -base64 32`. | `k3f9...==` (32 random bytes, base64) | Production **and** Preview | Secret | **Required** |
| `INTEGRATION_ENCRYPTION_KEY` | AES-256-GCM key (`src/lib/crypto.ts`) encrypting every stored integration credential at rest: WooCommerce consumer key/secret, Shopify access token, delivery-carrier API credentials (OzonExpress, Sendit, Ameex; Aramex for existing connections only), Google Drive OAuth tokens. Also the fallback backup-encryption key if `BACKUP_ENCRYPTION_KEY` is unset. | Generate locally: `openssl rand -base64 32`. Must decode to exactly 32 bytes (validated at boot). | `Yx7b...==` (32 random bytes, base64) | Production **and** Preview | Secret | **Required** |
| `APP_URL` | Canonical public base URL. Builds absolute links inside transactional emails (invitation, password reset, support-ticket forward — `src/lib/email.ts`) and the Google Drive OAuth redirect URI. Defaults to `http://localhost:3000` — **wrong** in any deployed environment. | The client's real domain (see Vercel domain setup). Never a `*.vercel.app` preview URL — those change per deployment. | `https://app.client-domain.com` | Production (its own real domain) **and** Preview (that deployment's URL, if emails are tested there) | Public (not a secret, but must be correct) | Strongly recommended (has a wrong default) |
| `RESEND_API_KEY` | API key for [Resend](https://resend.com), the transactional email provider (`src/lib/email.ts`). Unset ⇒ every email is logged to the server console instead of sent — a safe, working fallback, not an error. | Resend dashboard → API Keys. | `re_xxxxxxxxxxxx` | Production **and** Preview | Secret | Optional |
| `EMAIL_FROM` | The "From" address/name used for every outgoing email. Must be a sender verified on the `RESEND_API_KEY` account/domain, or Resend rejects the send. | Resend dashboard → Domains (after domain verification). | `ASODITECH <noreply@client-domain.com>` | Production **and** Preview | Public (not secret, but must match a verified Resend sender) | Optional (required if `RESEND_API_KEY` is set) |
| `BACKUP_ENCRYPTION_KEY` | Dedicated AES-256-GCM key for `.asb` backup package encryption (`src/lib/backup/container.ts`, `docs/adr/0034-backup-and-portability.md`). Unset ⇒ backups reuse `INTEGRATION_ENCRYPTION_KEY`. | Generate locally: `openssl rand -base64 32`. | `Qp2m...==` (32 random bytes, base64) | Production (and Preview if Preview is ever used for real backup testing) | Secret | Optional, but **strongly recommended** for any client relying on backups — see the warning below |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth 2.0 Web application client ID for the Backup module's optional Google Drive destination (`docs/adr/0034` Phase 2). Both Drive variables are optional together — unset ⇒ the Google Drive section shows "non configuré" and is fully inert. | Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application. | `1234567890-abc...apps.googleusercontent.com` | Production **and** Preview (one OAuth client can register multiple redirect URIs) | Public (client IDs are not secret, but treat as configuration) | Optional |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The paired OAuth client secret. | Same Google Cloud Console screen as above. | `GOCSPX-xxxxxxxxxxxxxxxxxxxx` | Production **and** Preview | Secret | Optional (required if `GOOGLE_OAUTH_CLIENT_ID` is set) |
| `WHATSAPP_ACCESS_TOKEN` | Permanent System User token of the ONE central ASODITECH WhatsApp Business (Cloud API) account, used for critical WhatsApp notifications (`src/lib/whatsapp/client.ts`, docs/adr/0058). Unset ⇒ nothing is sent on WhatsApp (logged only) — not an error. Never per-tenant. | Meta Business Suite → System users → Generate token (`whatsapp_business_messaging`). | `EAAG…` | Production only (leave unset on Preview) | Secret | Optional |
| `WHATSAPP_PHONE_NUMBER_ID` | Numeric id of the central sending number (not the phone number itself). The approved `fr` templates listed in docs/adr/0058 must exist in the same WhatsApp Business Account. | Meta App → WhatsApp → API Setup → Phone number ID. | `123456789012345` | Production only | Public (identifier, not secret) | Optional (required if `WHATSAPP_ACCESS_TOKEN` is set) |
| `WHATSAPP_GRAPH_API_VERSION` | Graph API version for WhatsApp calls. Defaults to `v23.0`. | Meta for Developers → Graph API changelog. | `v23.0` | Production | Public | Optional |
| `WHATSAPP_ALLOWED_RECIPIENTS` | Test mode: comma-separated phone numbers. When set, `src/lib/whatsapp/client.ts` sends ONLY to these numbers and refuses every other recipient before calling Meta. Unset ⇒ no restriction. | Your own staff test numbers. | `212600000001,212600000002` | Preview / local tests only (leave unset in Production) | Public | Optional |
| `WHATSAPP_ENABLED_TEMPLATES` | Comma-separated names of the post-V1 staff WhatsApp templates that Meta has APPROVED in the central account (docs/adr/0058 addendum). The four V1 templates are always sendable; any other template is recorded in the outbox as « Ignoré — modèle non approuvé/configuré » (a configuration problem, shown in Intégrations → Alertes WhatsApp — suivi) and never sent until listed here. | Meta Business Suite → WhatsApp Manager → Message templates: list each template once its status is « Approved ». | `asoditech_new_order,asoditech_order_confirmed,asoditech_stock_low,asoditech_order_returned` | Production (and Preview when testing a template) | Public | Optional |
| `CRON_SECRET` | Bearer secret of the protected cron routes — today `GET /api/cron/whatsapp-outbox` (WhatsApp retry processor). The route refuses every call (503) while unset and answers 401 to a wrong/missing `Authorization: Bearer …` (constant-time comparison). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically when the project defines it. | Generate it yourself (`openssl rand -hex 32`). | `3f9c…` (64 hex chars) | Production | Secret | Optional (required for automatic retries) |
| `SHOPIFY_INTEGRATION_ENABLED` | Deployment-wide kill switch for the Shopify adapter (`src/lib/integrations/shopify/feature-flag.ts`). The adapter is fully built and tested but shown as "Bientôt disponible" and refuses new connect/configure/sync actions unless this is the literal string `"true"`. Existing connections keep receiving webhooks regardless. | Set by you, per client, based on whether they use Shopify. | `true` or unset/`false` | Production **and** Preview | Public (a feature toggle, not a secret) | Optional (defaults to disabled) |
| `NODE_ENV` | Standard Next.js/Node environment marker. Also forces `src/lib/email.ts` onto the log-only path when `"test"`, regardless of Resend vars (keeps the test suite hermetic). | Set automatically by Vercel (`production` / `preview` / `development`) — do not set by hand in Vercel's dashboard. | `production` | Set by Vercel automatically | Public | Required, but never set manually on Vercel |

## WhatsApp staff alerts — what is automatic, what is not

- **Staff alerts (automatic)** go through the WhatsApp Cloud API from the one
  central ASODITECH number, and only when ALL of these hold: the
  `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` pair is set, the tenant
  switched WhatsApp on (Intégrations → WhatsApp, status « Connecté »), and the
  user verified their own number and opted in (Paramètres → Notifications).
  Each user can also mute any single alert type for WhatsApp there
  (`User.whatsappMutedAlerts`); in-app and email are never affected.
  The company can also switch any category off for everyone (Intégrations →
  « Alertes WhatsApp — suivi », `BusinessSettings.whatsappDisabledAlerts`,
  `integrations.manage`, audited).
- **Alerts sent on WhatsApp** (each needs its Meta template APPROVED, language
  `fr`, category Utility, in the central WhatsApp Business Account — nothing
  in the app creates them). « Available » = sendable by this build:

  | Alert | Template (body parameters, in order) | Available | Anti-flood rule |
  | --- | --- | --- | --- |
  | Rupture de stock | `asoditech_stock_out` ({{1}} product, {{2}} location) | always (V1) | once per item per day |
  | Échec de livraison | `asoditech_delivery_failure_summary` ({{1}} count, {{2}} carriers) | always (V1) | one summary per user per day |
  | Erreur de connexion boutique / transporteur / WhatsApp | `asoditech_integration_down` ({{1}} label) | always (V1) | once per integration per day |
  | Synchronisation boutique en échec complet, webhook boutique non traité | `asoditech_integration_down` (« WooCommerce (synchronisation commandes) », « WooCommerce (webhooks) ») | always (V1) | once per store + resource per day / once per integration per day |
  | Nouvelle commande (manual or imported) | `asoditech_new_order` ({{1}} order number, {{2}} origin: WooCommerce / Shopify / saisie ASODITECH) | only when listed in `WHATSAPP_ENABLED_TEMPLATES` | once per order; creator excluded |
  | Commande confirmée (queue or status change, WhatsApp only — no bell row) | `asoditech_order_confirmed` ({{1}} order number) | only when listed | once per confirmation; confirmer excluded |
  | Stock faible (≤ threshold, not exhausted) | `asoditech_stock_low` ({{1}} product, {{2}} available quantity, {{3}} location) | only when listed | once per item (product × location) per UTC day, even if the bell row was resolved meanwhile |
  | Commande retournée | `asoditech_order_returned` ({{1}} order number) | only when listed | once per order |

  Suggested bodies are listed in the « Alertes WhatsApp — suivi » card and in
  `src/lib/whatsapp/templates.ts` (`WHATSAPP_TEMPLATE_SPECS`); the approved
  wording may differ, the parameter count and order may not. Parameters never
  carry a price, a cost or customer data. Every new-order / confirmation
  alert goes to every opted-in `orders.view` holder: on a busy store, switch
  the category off for the company or let each user mute it.
- **Still in-app only**: payment problems, order stock shortage, workflow
  mismatches, partial syncs, usage thresholds, support tickets.
- **Customer messages are never automatic**: the « WhatsApp » buttons next
  to a customer open a `wa.me` link that a human sends by hand.
- **Test mode**: on Preview / local, set `WHATSAPP_ALLOWED_RECIPIENTS` to the
  staff test numbers — every other recipient is refused before Meta is
  called. The automated test suite never calls Meta (`isWhatsAppConfigured()`
  is false under `NODE_ENV=test`; tests mock the client).
- **Outbox, retries (docs/adr/0058 addendum).** Every WhatsApp alert is a row
  of `whatsapp_outbox` (one per event and recipient, idempotent on the event's
  dedupe key) sent right after the business action. Network errors, Meta 5xx,
  429 and rate-limit codes are retried with backoff (1, 4, 16, 64 min — 5
  attempts, then « Échec »); a permanent Meta refusal is « Échec » at once;
  an admin can « Réessayer » a failed row. Meta accepting a message is still
  not proof it was delivered (no delivery receipts).
- **Relances WhatsApp (scheduling).** Retries happen opportunistically on the
  next alert of the same company, and — for a guaranteed cadence — through
  `GET /api/cron/whatsapp-outbox` with `Authorization: Bearer $CRON_SECRET`.
  `vercel.json` is NOT changed by the app: to schedule it on Vercel, add
  `"crons": [{ "path": "/api/cron/whatsapp-outbox", "schedule": "*/10 * * * *" }]`
  (Pro plan; on Hobby, once a day only), and set `CRON_SECRET`. Any external
  scheduler can call the same URL with the same header.

## Not a Vercel project variable

| Variable | Purpose | Where used |
| --- | --- | --- |
| `SEED_OWNER_EMAIL` | Email of the first OWNER account created by `prisma/seed.ts`. | Passed inline on the operator's own machine when running `pnpm exec tsx prisma/seed.ts` **once** against the production database — see the runbook's "First admin/owner" section. Never added to Vercel's Environment Variables; the deployed app never reads it. |
| `SEED_OWNER_PASSWORD` | Password for that first OWNER account. **Required** by the seed script whenever `NODE_ENV=production` — the script refuses to run without it rather than create the account with the well-known local default password (`change-me-immediately`). | Same as above — local invocation only. |

`tests/acceptance-backup-run.ts`'s `OWNER_A` / `WH_A` / `OWNER_B` are
authenticated-session cookies for a manual acceptance script, not
deployment configuration — never set these anywhere near a real
deployment.

## Secrets that must NEVER be pasted into this app's own config

These are credentials for *other* systems, entered through the app's UI
(Intégrations / Livraison / Réglages → Sauvegarde) and stored **encrypted
in the database** via `INTEGRATION_ENCRYPTION_KEY` — never as Vercel
environment variables:

- WooCommerce REST API Consumer Key/Secret
- Shopify custom app Admin API access token + Client secret
- OzonExpress Customer ID + API key
- Sendit public key + secret key (`public_key` / `secret_key`)
- Ameex API Id + API Key (a key starting with `test_` targets the Ameex sandbox) + the optional webhook signature secret (without it Ameex webhooks are unsigned and always refused)
- Aramex `ClientInfo` (Username, Password, AccountNumber, AccountPin, AccountEntity, AccountCountryCode) — **existing Aramex connections only**: Aramex is retired for new connections since 2026-10-15/16 (`docs/adr/0060`)
- A tenant's own Google account OAuth tokens (obtained via the in-app "Connecter Google Drive" flow, not a shared app-level credential)

Only the two `GOOGLE_OAUTH_CLIENT_*` values above (this app's own OAuth
*client*, shared across every tenant on one deployment) belong in Vercel's
environment variables — never an individual tenant's resulting access/
refresh token.

## Why `BACKUP_ENCRYPTION_KEY` deserves special care

If this key (or the `INTEGRATION_ENCRYPTION_KEY` fallback) is ever lost,
**every existing `.asb` backup package becomes permanently
unrecoverable** — there is no recovery path, by design (it is an
authenticated-encryption key, not a password). Store a copy outside the
database (a password manager, the client's own secrets vault) the moment
it is generated, before the first real backup is taken.

## Keeping this document honest

`tests/lib/deployment-docs-coverage.test.ts` statically reads the keys
declared in `src/lib/env.ts`'s Zod schema plus the small set of
non-schema runtime variables documented above (`DIRECT_URL`,
`SHOPIFY_INTEGRATION_ENABLED`, `SEED_OWNER_EMAIL`, `SEED_OWNER_PASSWORD`)
and fails if any of them is missing from `.env.production.example` or
from this file's table. It does **not** check prose accuracy — when you
add or remove an environment variable, update both files by hand and
re-run `pnpm test` before merging.
