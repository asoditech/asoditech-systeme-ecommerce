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
| `INTEGRATION_ENCRYPTION_KEY` | AES-256-GCM key (`src/lib/crypto.ts`) encrypting every stored integration credential at rest: WooCommerce consumer key/secret, Shopify access token, OzonExpress/Aramex API credentials, Google Drive OAuth tokens. Also the fallback backup-encryption key if `BACKUP_ENCRYPTION_KEY` is unset. | Generate locally: `openssl rand -base64 32`. Must decode to exactly 32 bytes (validated at boot). | `Yx7b...==` (32 random bytes, base64) | Production **and** Preview | Secret | **Required** |
| `APP_URL` | Canonical public base URL. Builds absolute links inside transactional emails (invitation, password reset, support-ticket forward — `src/lib/email.ts`) and the Google Drive OAuth redirect URI. Defaults to `http://localhost:3000` — **wrong** in any deployed environment. | The client's real domain (see Vercel domain setup). Never a `*.vercel.app` preview URL — those change per deployment. | `https://app.client-domain.com` | Production (its own real domain) **and** Preview (that deployment's URL, if emails are tested there) | Public (not a secret, but must be correct) | Strongly recommended (has a wrong default) |
| `RESEND_API_KEY` | API key for [Resend](https://resend.com), the transactional email provider (`src/lib/email.ts`). Unset ⇒ every email is logged to the server console instead of sent — a safe, working fallback, not an error. | Resend dashboard → API Keys. | `re_xxxxxxxxxxxx` | Production **and** Preview | Secret | Optional |
| `EMAIL_FROM` | The "From" address/name used for every outgoing email. Must be a sender verified on the `RESEND_API_KEY` account/domain, or Resend rejects the send. | Resend dashboard → Domains (after domain verification). | `ASODITECH <noreply@client-domain.com>` | Production **and** Preview | Public (not secret, but must match a verified Resend sender) | Optional (required if `RESEND_API_KEY` is set) |
| `BACKUP_ENCRYPTION_KEY` | Dedicated AES-256-GCM key for `.asb` backup package encryption (`src/lib/backup/container.ts`, `docs/adr/0034-backup-and-portability.md`). Unset ⇒ backups reuse `INTEGRATION_ENCRYPTION_KEY`. | Generate locally: `openssl rand -base64 32`. | `Qp2m...==` (32 random bytes, base64) | Production (and Preview if Preview is ever used for real backup testing) | Secret | Optional, but **strongly recommended** for any client relying on backups — see the warning below |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth 2.0 Web application client ID for the Backup module's optional Google Drive destination (`docs/adr/0034` Phase 2). Both Drive variables are optional together — unset ⇒ the Google Drive section shows "non configuré" and is fully inert. | Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application. | `1234567890-abc...apps.googleusercontent.com` | Production **and** Preview (one OAuth client can register multiple redirect URIs) | Public (client IDs are not secret, but treat as configuration) | Optional |
| `GOOGLE_OAUTH_CLIENT_SECRET` | The paired OAuth client secret. | Same Google Cloud Console screen as above. | `GOCSPX-xxxxxxxxxxxxxxxxxxxx` | Production **and** Preview | Secret | Optional (required if `GOOGLE_OAUTH_CLIENT_ID` is set) |
| `SHOPIFY_INTEGRATION_ENABLED` | Deployment-wide kill switch for the Shopify adapter (`src/lib/integrations/shopify/feature-flag.ts`). The adapter is fully built and tested but shown as "Bientôt disponible" and refuses new connect/configure/sync actions unless this is the literal string `"true"`. Existing connections keep receiving webhooks regardless. | Set by you, per client, based on whether they use Shopify. | `true` or unset/`false` | Production **and** Preview | Public (a feature toggle, not a secret) | Optional (defaults to disabled) |
| `NODE_ENV` | Standard Next.js/Node environment marker. Also forces `src/lib/email.ts` onto the log-only path when `"test"`, regardless of Resend vars (keeps the test suite hermetic). | Set automatically by Vercel (`production` / `preview` / `development`) — do not set by hand in Vercel's dashboard. | `production` | Set by Vercel automatically | Public | Required, but never set manually on Vercel |

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
- Aramex `ClientInfo` (Username, Password, AccountNumber, AccountPin, AccountEntity)
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
