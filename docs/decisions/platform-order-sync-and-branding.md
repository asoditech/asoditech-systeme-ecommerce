# Decision required — per-company order-sync switches and company logo (platform)

Status: **proposal, not implemented** (2026-10-13). Requirement 3 of the
2026-10-12 plan: the platform administrator enables or hides order
synchronisation per company, independently for WooCommerce and Shopify, and
may replace the ASODITECH logo with the company's logo. Hiding a button is
not enough: the server must refuse.

## Why no change was made without approval

- **Order-sync switches need a new column.** The only per-company storage
  today is `Tenant` (fixed columns, no JSON) and the company's own
  `Integration.config`. `Integration.config` is not safe for a platform
  switch: the row does not exist before the company connects, re-saving
  the connection rewrites it (since 2026-10-13 only the company's own
  audited choices survive, and only for the same store address — see
  `connectIntegrationAction`), and a company administrator holds
  `integrations.manage` on it.
- **The logo already exists, but for another purpose.**
  `BusinessSettings.logoUrl` is the company's own logo for invoices,
  statements and reports, edited by the company in Paramètres
  (`src/components/settings/logo-field.tsx`). Showing it in the app shell
  is a product decision: should the company control its in-app branding,
  or only the platform administrator?

## Proposal (additive, nullable/defaulted — no data rewritten)

```prisma
model Tenant {
  // …
  wooOrderSyncEnabled     Boolean @default(true)   // platform-controlled
  shopifyOrderSyncEnabled Boolean @default(true)   // platform-controlled
  brandLogoEnabled        Boolean @default(false)  // option A below
}
```

- **Writer:** one platform action, guarded like the existing platform
  actions (`requirePlatformAdminForAction`, e.g. `src/actions/tenants.ts`),
  audited (`tenant.updated`, previous → new).
- **Enforcement (server):** `syncWooCommerceOrdersAction`,
  `syncShopifyOrdersAction`, `src/actions/sync.ts` (the combined sync) and
  the `order.created` / `orders/create` webhook paths refuse or ignore
  (`IGNORE` webhook status) when the switch is off; the integrations card
  hides the « Commandes » row. Existing orders are never touched.
- **Logo, option A (no new storage):** `brandLogoEnabled` lets the shell
  show `BusinessSettings.logoUrl`; the company keeps editing the image.
  **Option B:** a separate platform-owned `Tenant.brandLogoUrl` (validated
  like `logoUrl`: https URL, no data URIs), independent of invoices.

## Open decisions

1. Option A or B for the logo (who controls in-app branding)?
2. When order sync is off: are incoming order webhooks ignored, or kept
   and imported later when the switch is turned back on?
3. Should turning the switch off also hide past imported orders? (Proposal:
   no — history stays.)

Tests to add with the migration: switch off → manual sync refused, combined
sync skips that provider, webhook answered without import, other company
unaffected, non-platform users refused, audit written.
