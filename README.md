# ASODITECH — Gestion E-commerce

Système de gestion e-commerce ASODITECH : commandes, clients, produits,
stock, livraison, finance, marketing, utilisateurs et permissions, journal
d'audit, intégrations et assistant IA.

See `docs/adr/` for the architecture decisions behind this codebase — read
those before making framework, auth, schema, or domain-model changes. This
project shares its stack and conventions with the sibling **ASODITECH
Control Center** repository (`../ASODITECH Control Center/`); see
`docs/adr/0001-tech-stack.md` for why.

## Stack

Next.js 16 (App Router) · TypeScript · PostgreSQL · Prisma 6 · Tailwind CSS
v4 + shadcn/ui (`@base-ui/react`) · Zod v4 · Vitest · Recharts.

Next.js 16 and this shadcn style changed several conventions since most
training data was written (`middleware.ts` → `proxy.ts`, fully-async
`params`/`cookies()`/`headers()`, `Select` needs an explicit label
formatter rather than deriving it from `SelectItem` children — see
`src/components/ui/select.tsx`, and `Button` composed with `render` for a
non-button element needs `nativeButton={false}`, handled automatically in
`src/components/ui/button.tsx`). `AGENTS.md` points at the bundled Next.js
docs in `node_modules/next/dist/docs/`.

## Prerequisites

- Node.js 20.9+ (developed against Node 24)
- pnpm
- A local PostgreSQL server (no Docker in this environment; Postgres runs
  directly via Homebrew, `postgresql@16`).

## Setup

```bash
pnpm install
createdb asoditech_ecommerce
createdb asoditech_ecommerce_test
cp .env.example .env      # then fill in DATABASE_URL / DIRECT_URL / AUTH_SECRET / INTEGRATION_ENCRYPTION_KEY
npx prisma migrate deploy # applies prisma/migrations, via DIRECT_URL
pnpm db:seed               # creates the initial OWNER account (see below)
pnpm dev
```

`DATABASE_URL` and `DIRECT_URL` can be identical locally. In production
they must differ if you put a connection pooler (e.g. Supabase's
PgBouncer) in front of Postgres — see `docs/adr/0001-tech-stack.md`.

`AUTH_SECRET` and `INTEGRATION_ENCRYPTION_KEY`: generate each with
`openssl rand -base64 32`.

`pnpm db:seed` creates one `User` row (role `OWNER`), the default
warehouse, the business settings singleton row, and the standard expense
categories — it does **not** create any customers, products, orders, or
other business data. An empty dashboard after seeding is correct, not a
bug (see the project's Data Integrity Principle). Override the seeded
credentials with `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`; without them
it uses `owner@asoditech.local` / `change-me-immediately` and prints a
reminder to change the password.

## Testing

Tests run against a **separate** database (`asoditech_ecommerce_test` by
default, configured in `.env.test`) so `pnpm test` can freely wipe tables
between test cases. `tests/helpers/db.ts` refuses to run if `DATABASE_URL`
doesn't look like a test database — never point `.env.test` at real data.

```bash
npx dotenv -e .env.test -- npx prisma migrate deploy   # first time
pnpm test                                                # run once
pnpm test:watch                                           # watch mode
```

## Deployment (Vercel)

This system is deployed as **one Vercel project + one PostgreSQL database
per client instance** (see `docs/adr/0002-domain-model.md` — isolation is
at the deployment level, there is no `tenantId`).

1. **Provision a PostgreSQL database** the Vercel build and functions can
   reach (Neon, Supabase, Vercel Postgres, …).

2. **Set the project's Environment Variables** (Project → Settings →
   Environment Variables), for every environment you deploy:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | pooled connection string (PgBouncer / port 6543 on Supabase) |
   | `DIRECT_URL` | direct connection string (port 5432); may equal `DATABASE_URL` if there is no pooler |
   | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `INTEGRATION_ENCRYPTION_KEY` | `openssl rand -base64 32` (base64-encoded 32 bytes) |

   `NODE_ENV` is set to `production` by Vercel automatically. Without these
   four, `next build` fails while collecting routes (`src/lib/env.ts`
   validates them at import).

3. **Build command** — leave it on the default. Vercel automatically runs
   the `vercel-build` script when one is present, which here is
   `prisma migrate deploy && next build`: it applies `prisma/migrations`
   to the production DB (using `DIRECT_URL`) and then builds. `prisma
   generate` still runs from `postinstall` and no longer needs a database
   URL — see the comment in `prisma.config.ts`. (If you prefer, set the
   Build Command explicitly to `pnpm vercel-build`.)

4. **Seed the first owner account** once, from your machine, pointed at the
   production database:

   ```bash
   DATABASE_URL="<prod DIRECT_URL>" SEED_OWNER_EMAIL="you@example.com" \
     SEED_OWNER_PASSWORD="<a strong password>" pnpm exec tsx prisma/seed.ts
   ```

   `SEED_OWNER_PASSWORD` is **required** outside local dev. The seed is
   idempotent (upsert) — safe to re-run, and it never creates business
   data.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the dev server |
| `pnpm build` | Production build (`next build`) |
| `pnpm vercel-build` | `prisma migrate deploy && next build` — Vercel build command |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Vitest, against `.env.test`'s database |
| `pnpm db:seed` | Create the initial OWNER account and system fixtures |

## What's fully built vs. scaffolded

See the implementation report delivered alongside this codebase for the
current, authoritative state. In short: Dashboard, Customers, Products,
Orders (with full state machine + inventory side effects), Inventory,
Delivery, Finance, Analytics, Users & Permissions, Notifications, and the
Audit Log are real, working, permission-enforced modules with tests.
**WooCommerce** and **Shopify** both have real adapters — connection
test, product/variant import, bidirectional stock sync (per-location for
Shopify), order import (with customer/refund handling), and
signature-verified order webhooks — see
`docs/adr/0010-woocommerce-integration.md` and
`docs/adr/0011-shopify-integration.md`. Marketing and the remaining
Integrations (ad platforms, WhatsApp, email, Google Sheets, AI provider)
have real CRUD for what's genuinely buildable without a live external
connection (channels/campaigns; credential storage) and honest "planned"
states for what isn't. The AI Assistant is a controlled tool layer (real
data, no fabrication) with no LLM wired in yet — see
`docs/adr/0009-ai-tool-layer.md`.

**Notifications**: the in-app bell/inbox (top bar + `/notifications`) is
wired to real business events, not a static UI shell — a new order (manual
or imported from WooCommerce/Shopify, sync or webhook), a payment failure,
a returned order, a failed shipment, an item crossing its low-stock/
out-of-stock threshold (manual adjustment or provider stock reconciliation
alike), a failed delivery/WooCommerce/Shopify connection test, and a
failed or partial sync run each fan out — best-effort, concurrency-safe,
deduplicated — to every active user who already holds that event's own
read permission. See `docs/adr/0016-notifications.md`.

**Delivery-provider API connectors**: the full adapter architecture
(capability model, registry, credential storage, connection lifecycle,
shipment create/cancel/status-sync, webhook signature-verification and
replay-protection plumbing) is built and tested against a fixture
connector — see `docs/adr/0012-delivery-provider-integration.md`. The
"Configurer" control on a `type = API` provider (Livraison → Prestataires)
is disabled with an honest "no connector available" message until a real
carrier's adapter is added under `src/lib/integrations/delivery/providers/`
and registered in that directory's `index.ts` — at that point it becomes
selectable with no further schema or UI change needed.

**OzonExpress (Maroc)** — adapter under
`src/lib/integrations/delivery/providers/ozonexpress/`, fixture-tested
end-to-end (`CREATE_SHIPMENT` / `FETCH_STATUS` / `FETCH_COST` /
`GENERATE_MANIFEST`; no cancellation or webhook — OzonExpress has
neither). The adapter is
**registered**: it shows up in Livraison → Prestataires → Configurer with
password-masked Customer ID / Clé API fields. Registration does **not**
mean connected — saving credentials is `CONFIGURE`; only a successful
"Tester la connexion" (an authenticated `tracking` read + `GET /cities`,
never a parcel) transitions to `CONNECTE`. Per-client credentials
(`{"customerId":"…","apiKey":"…"}`) are encrypted at rest, one
`ShippingProvider` row per client/instance, never shared. Delivery cost
comes from OzonExpress's authoritative per-city price (`GET /cities`, 801
cities); a `cityIdByName` override map in the connector config handles
spelling corrections. ✅ Authentication (`CHECK_API`), the `tracking`
envelope, and `GET /cities` are verified against a real account. ⚠️
`add-parcel` and the Bon de Livraison flow (Livraison → « Bons de
livraison » : batch parcels onto a carrier delivery note, then open the
bordereau + label PDFs on the OzonExpress portal) have not been run live
and some status wording is still a best guess — see
`docs/adr/0013-ozonexpress-integration.md` (`REAL_PARCEL_CREATED = NO`)
and `docs/adr/0015-delivery-manifest.md` (`MANIFEST_LIVE_TESTED = NO`).

### WooCommerce setup
1. In WooCommerce admin: WooCommerce → Réglages → Avancé → REST API →
   Ajouter une clé, with Read/Write permissions. Copy the consumer key and
   secret.
2. In this app: Intégrations → WooCommerce → Configurer, paste the store
   URL (HTTPS only) and the key/secret, then Enregistrer.
3. Click "Tester la connexion" to verify — this is what actually confirms
   the connection works, not the save step.
4. Click "Synchroniser les produits" and "Synchroniser les commandes" to
   run a first import. "Pousser le stock" sends current internal stock
   back to WooCommerce for already-linked products.
5. Optionally, click "Générer un secret webhook", then in WooCommerce
   admin → Réglages → Avancé → Webhooks, create two webhooks (topics
   "Commande créée" and "Commande mise à jour") pointing at the URL shown,
   pasting in the generated secret. This makes new/updated orders import
   in near-real-time instead of waiting for the next manual sync.

### Shopify setup
1. In Shopify, use an existing custom app's Admin API access token (new
   custom apps can no longer be created from the classic Shopify admin —
   use the Shopify Dev Dashboard/CLI if you need a new one). The app needs
   at minimum `read_products`, `read_inventory`, `read_orders`, and
   `write_inventory` (only if you intend to push stock back) scopes.
2. In this app: Intégrations → Shopify → Configurer. Enter the shop name
   (e.g. `mon-magasin`, or the full `mon-magasin.myshopify.com` — a custom
   connected domain is not accepted; the Admin API is only called at the
   `myshopify.com` domain) and the access token. The webhook secret field
   is optional at this step — see step 4.
3. Click "Tester la connexion" — only a real successful request marks the
   integration Connecté; saving credentials alone never does.
4. Click "Synchroniser les produits" (imports active Locations as
   warehouses, then products/variants with per-location stock) and
   "Synchroniser les commandes". "Pousser le stock" sends current
   sellable internal stock back to Shopify, per location, for
   already-linked products.
5. For near-real-time order updates, open "Configurer les webhooks" on
   the Shopify card to see the delivery URL, then in Shopify (custom app
   → API configuration → Webhooks) subscribe to "Order creation",
   "Order update", "Order cancellation", and "Refund creation", signed
   with the app's own **Client secret** — enter that same value as the
   webhook secret in step 2 (edit the connection again if you skipped it).

### OzonExpress (livraison) setup
1. In this app: Livraison → onglet **Prestataires** → "Nouveau
   prestataire", type **API**, name it (e.g. "OzonExpress").
2. On that row, click **Configurer**, choose the **OzonExpress (Maroc)**
   connector, and enter your **Identifiant client OzonExpress** and
   **Clé API OzonExpress** (from OzonExpress; the key is masked and never
   shown again). Optional JSON config: `stockMode` (`"ramassage"` default
   or `"stock"`), `defaultParcelNature`, and a `cityIdByName` map to
   correct any city names the catalogue spells differently. Save → the row
   is **Configuré (non vérifié)**.
3. Click **Tester la connexion** — this makes one authenticated `tracking`
   read (empty code) plus `GET /cities`; it never creates a parcel. Only a
   success marks the row **Connecté** and shows OzonExpress's
   authentication message and the number of served cities.
4. Create shipments from Livraison → "À expédier" once the row is
   Connecté. The delivery cost is taken from OzonExpress's per-city price
   (`GET /cities`). There is no cancellation and no webhook (OzonExpress
   has neither); status is updated by the per-shipment "Synchroniser"
   button.

✅ Authentication, the `tracking` response envelope, and `GET /cities`
(801 cities with per-city pricing) were verified against a real
OzonExpress account. ⚠️ `add-parcel` has **not** been run live yet, and
the delivered/returned/refused status wording is still a best guess — see
`docs/adr/0013-ozonexpress-integration.md`.

### Known limitations (both integrations)
- Real-time stock locking across this system's own manually-created
  orders and the live storefront isn't implemented — only pull/push sync
  runs and order webhooks keep data current between explicit
  synchronizations.
- Shopify's product categories/Collections are not mapped in this phase
  — see `docs/adr/0011-shopify-integration.md`.
- **No live WooCommerce or Shopify credentials have been used to verify
  this codebase against a real store.** Both adapters were built and
  tested against official API documentation plus mocked HTTP responses
  and a real local test database — not a live merchant account. Connect a
  real store and use "Tester la connexion" to verify your own setup
  before relying on it.
