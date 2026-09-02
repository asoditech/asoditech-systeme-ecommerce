# ADR 0017 — Product management boundary (Phase 28)

## Status
Accepted (2026-09-02)

## Context
ASODITECH already lets staff create and edit any product natively —
`ProductForm` (`src/components/products/product-form.tsx`) powers both
`/produits/nouveau` and the product detail page's "Modifier" tab,
regardless of whether the product is internal or was imported from
WooCommerce/Shopify. That's a real problem for a synced product: every
field `ProductForm` edits (name, SKU, price, description, status,
category) is explicitly **provider-owned** for a synced record per both
mappers' own "Field ownership" comments (`woocommerce/mapper.ts`,
`shopify/mapper.ts`) — it is silently overwritten by the very next
"Synchroniser les produits" run or product-update webhook. An edit made
in ASODITECH's form looked like it worked and then quietly vanished.

The owner's decision: stop pretending ASODITECH is a product editor for
externally-sourced products. Product *definition* lives on the platform
that owns it; ASODITECH is the operational command center — quantities,
orders, delivery, finance, notifications — never a second WooCommerce or
Shopify admin.

## Decision

### 1. No new source model — the existing one already fits
`Product.source` (`RecordSource`: `INTERNE | WOOCOMMERCE | SHOPIFY`) and
`Product.externalId` already exist and are already set correctly by both
sync pipelines (Phases 20/21). Nothing added to the schema. The
WooCommerce `externalId` is the plain numeric WordPress post ID
(`String(wc.id)`); the Shopify `externalId` is the full GraphQL gid
(`"gid://shopify/Product/123"`) — the admin URL below takes just its
trailing numeric segment, the same pattern `skuOrFallback` already uses
for a SKU-less Shopify variant.

### 2. One new module builds every external admin URL —
`src/lib/integrations/shared/product-management-url.ts`
Two functions, both server-only, both reading only trusted data:

- `getConnectedCommercePlatforms()` — every provider with a genuine
  `CONNECTE` `Integration` row (a real verified connection test, not just
  saved credentials — same bar as everywhere else in this codebase) and a
  resolvable config, each with its real "create a new product" admin URL.
  Powers `/produits/nouveau`.
- `resolveExternalProductEditUrl(product)` — the real edit-page URL for
  one already-imported product, built from `Integration.config.siteUrl`
  (WooCommerce) / `.shopDomain` (Shopify) — both already normalized,
  HTTPS-only origins validated by `validateStoreUrl`/`validateShopDomain`
  at connect time — plus the product's own `externalId`. Returns `null`
  on any unresolvable state (disconnected, missing config, missing
  external id) — **never a guessed URL**. Powers the "Modifier sur
  WooCommerce/Shopify" CTA and its clear-error fallback.

No canonical builder existed to reuse (grepped for `wp-admin`/
`admin.shopify`/`myshopify` outside the SSRF validators — nothing). Both
functions are pure `origin + known-static-path + own-database-id`
string-building, re-validated with `new URL()` before use as one more
guard against a corrupted config value — no network call, no
`dangerouslySetInnerHTML`, no redirect endpoint that accepts a URL
parameter (so there is no open-redirect surface to begin with, not one
that's merely mitigated). Browser navigation only, via a plain `<a
href>` — the ASODITECH server never fetches a WordPress/Shopify admin
page, and never touches the operator's session on that platform.

### 3. "Ajouter un produit" never opens a native form again
`/produits/nouveau` is now a **gateway page**, unconditionally:
- **0 connected platforms** → `EmptyState` explaining a connection is
  required, with a link to `/integrations`. No fallback to a native
  create form, even though nothing here is technically stopping
  `createProductAction` from working — see "Deferred" below.
- **1 connected** → one prominent card, one click, straight to that
  platform's real creation page (new tab).
- **2 connected** → both offered as cards; never guessed.

`createCategoryAction`/`createProductAction` themselves are untouched —
"prefer the smallest change," and `createProductAction` is still the
correct, legitimate path for a genuinely `INTERNE` product (see
"Deferred").

### 4. "Modifier le produit" — boundary enforced at both layers
For an externally-sourced product, the product detail page:
- adds a **"Modifier sur WooCommerce/Shopify"** button next to the status
  badge in the page header (visible immediately, not buried in a tab);
- the "Modifier" tab no longer renders `ProductForm` — instead a card
  restating "this product is managed on X" with the same CTA, and (see
  below) the fields ASODITECH still genuinely owns;
- if the URL can't be resolved (disconnected/misconfigured integration),
  a clear amber notice names the reason and links to `/integrations` —
  never a guessed link, never a silent failure.

This is enforced **server-side, not just hidden in the UI** — the same
"a user who cannot see a button must also be rejected here" principle
`requirePermissionForAction` already documents for permissions.
`updateProductAction` and `createProductVariationAction` now both reject
(French `actionError`, no exception) when the target product's
`source !== "INTERNE"`. A crafted request calling either directly can't
bypass the boundary just because the UI doesn't offer the button.

### 5. What ASODITECH still genuinely owns, even on a synced product
`cost`, `trackInventory`, and `lowStockThreshold` are **never** touched
by either sync (see each mapper's own "Field ownership" comment) — they
were always internal-only, not part of the boundary this phase draws. A
new, narrow action — `updateProductOperationalSettingsAction` +
`updateProductOperationalSettingsSchema` — edits exactly these three
fields, for a product of **any** source, surfaced as a small
"Paramètres internes" card next to the external-source notice. Nothing
here can ever be silently overwritten by a sync, so there's no
duplicate-source-of-truth problem to guard against.

### 6. Variations
The variations table (already read-only display) is unchanged. Only
`VariationForm`'s "Ajouter une variation" button is now conditional on
`source === "INTERNE"` — creating a new variation is catalog editing,
the same class of action as creating/editing the product itself.

## Deferred (explicitly, not silently)
- **`createProductAction` is not itself locked down.** It still creates
  an `INTERNE` product exactly as before if called — there is no
  legitimate "this product is externally sourced" state to violate at
  creation time (a product doesn't have a source until it's created),
  unlike `updateProductAction`/`createProductVariationAction`, which
  guard an *existing* record's already-known source. The boundary here is
  a workflow/UI decision (no button reaches this action for external
  creation anymore, and the gateway page's own copy says why), not a
  vulnerability being closed — see "Do NOT delete existing Product
  functionality" and "prefer the smallest change" in the phase brief.
- **Category creation/editing** (`createCategoryAction`) is untouched —
  categories are a shared taxonomy tool, not a single product's
  definition, and the phase brief doesn't name it.
- **No product image upload, media manager, SEO editor, description
  editor, tax editor, publishing workflow, bulk editor, or PIM** — all
  explicitly out of scope per the phase brief's own "Scope discipline"
  list, and none existed before this phase either.
