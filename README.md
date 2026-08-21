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

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the dev server |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm test` | Vitest, against `.env.test`'s database |
| `pnpm db:seed` | Create the initial OWNER account and system fixtures |

## What's fully built vs. scaffolded

See the implementation report delivered alongside this codebase for the
current, authoritative state. In short: Dashboard, Customers, Products,
Orders (with full state machine + inventory side effects), Inventory,
Delivery, Finance, Analytics, Users & Permissions, and the Audit Log are
real, working, permission-enforced modules with tests. Marketing and
Integrations have real CRUD for what's genuinely buildable without a live
external connection (channels/campaigns; WooCommerce/Shopify credential
storage) and honest "planned" states for what isn't. The AI Assistant is a
controlled tool layer (real data, no fabrication) with no LLM wired in yet
— see `docs/adr/0009-ai-tool-layer.md`.
