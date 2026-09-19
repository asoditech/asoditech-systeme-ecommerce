# ADR 0041 — Tenant business mode (Online-only vs Online + Offline)

## Status
Accepted (2026-09-19). Sits on top of ADR 0038 (channels, catalog identity, ledger
hardening), 0039 (permission overrides + channel scope) and 0040 (sales, purchasing,
traceability). Those domains are **not changed**; this ADR decides *for which tenants
they are switched on*. Additive migration `20260919130000_tenant_business_mode`.

## Context
After ADR 0038–0040 every tenant would see store sales, suppliers/receptions,
barcodes, traceability and channel administration — and, worse, ADR 0039's channel
scoping would make a user with no `UserChannel` row lose access to Online data. Most
tenants are pure e-commerce operators; for them the product must remain **exactly what
it was before** — no new menus, no new form fields, no behavioural change, no
lock-out. A tenant that also runs physical stores opts in.

## Decision

### Two modes, one column
`Tenant.businessMode` (`TenantBusinessMode` enum, `NOT NULL DEFAULT 'ONLINE_ONLY'`).

| Mode | Meaning |
|---|---|
| `ONLINE_ONLY` (default) | The pre-existing product. No Offline capability exists for the tenant. |
| `ONLINE_AND_OFFLINE` | Everything above plus every Offline capability. |

**Backfill:** the column default backfills every existing tenant to `ONLINE_ONLY`, so
deploying the migration changes nothing for anyone. `resetDb()` in the test suite does
the same, which is why the whole legacy test suite passes unmodified as proof of
equivalence; only the A–G suites opt in to `ONLINE_AND_OFFLINE`.

A tenant's mode is **independent of its plan** (ADR 0035): plans meter usage
(orders, users…), the mode chooses which product surface exists. It is not shown on
the tenant-facing Abonnement page.

### Capabilities — the single mapping (`src/lib/tenant/business-mode.ts`, pure)
`ONLINE_ONLY` unlocks nothing; `ONLINE_AND_OFFLINE` unlocks all five:

| Capability | Owns |
|---|---|
| `offlineSales` | `sales.view/create/return/override_price`, Ventes pages, sale search, Offline KPI |
| `storeChannels` | `channels.manage`, Canaux de vente settings, product↔channel availability, per-user channel assignment, the Online/Offline/Total report + CSV, store-only products |
| `purchasing` | `suppliers.view/manage`, `purchases.view/create/pay`, Fournisseurs / Réceptions pages |
| `catalogIdentity` | barcodes, model reference, inline category creation with derived slug, code lookup |
| `traceability` | `traceability.view` (new permission; the page previously reused `stock.view`) |

Supplier-side features (suppliers, receptions, supplier payments) and
barcodes/traceability are deliberately treated as Offline-era capabilities: an
online-only shop never had them, and the requirement is that its surface stays the
old one.

### Enforcement is server-side, at the permission engine
`computeEffectiveAccess({ role, overrides, assignedChannels, businessMode })`
(`src/lib/auth/effective-access.ts`) removes every capability-gated permission from
the effective set **for every role, OWNER and ADMIN included**. Every page, Server
Action and route handler already guarded by those permissions (all of A–G) is closed
by construction — no per-call-site edits were needed for them. The nav, docs
categories/articles, quick search, dashboards and reports read the same set/
capabilities, so hiding and refusing can never disagree.

Surfaces that are not a permission check use `requireCapability` (pages, redirect
to `/acces-refuse`) / `requireCapabilityForAction` (actions, throws
"Non autorisé : cette fonctionnalité n'est pas activée pour votre espace.") from
`src/lib/auth/capabilities.ts`: catalog identity actions, product-channel actions,
user-channel assignment, the `canaux` report and export, and the product/variation
forms (`identityEnabled`).

### `ONLINE_ONLY` ignores channel machinery entirely
For non-global roles in an `ONLINE_ONLY` tenant the channel scope resolves to
`online: true, offline: false` **regardless of `UserChannel` rows**. This is the
lock-out guard: a CONFIRMATION/MANAGER user created before ADR 0039 has no channel
rows and must keep every Online read/notification exactly as before. Notification
recipient selection uses the same resolved scope, so it is unchanged too.

Product creation in `ONLINE_ONLY` ignores `reference`, `barcode`, `salesChannelIds`
and the variation barcode, and attaches the product to the default Online channel
(the pre-ADR-0038 behaviour: every product sellable online); category creation keeps
its historical explicit-slug contract.

### What is deliberately NOT gated (invariants, not features)
- The override engine (`UserPermissionOverride`), role model, and `requirePermission*`.
  Overrides for unavailable permissions are *refused on write* and inert on read; a
  DENY of an available permission works in both modes.
- Ledger hardening (`applyStockMovement`, extra movement columns), archive protection,
  barcode/SKU uniqueness at the DB level — schema-level invariants that hold in every
  mode.
- The default Online `SalesChannel` — created for every tenant (provisioning and
  upgrade), it is the identity of "online".
- Tables: all A–G tables exist for every tenant; the mode gates behaviour, not schema.
  RLS is unchanged.
- Backup/restore: `Tenant` is not part of a backup, so restoring never changes the
  mode; A–G data is backed up whatever the mode.

### Provisioning & changing the mode (`/platform`, platform admins only)
- `createTenantAction` takes `businessMode` (blank/omitted → `ONLINE_ONLY`; an unknown
  value is rejected by `createTenantSchema`). Provisioning is otherwise identical for
  both modes. Recorded in the `tenant.created` audit payload.
- `setTenantBusinessModeAction` / `previewTenantBusinessModeChange` (guarded by
  `isPlatformAdmin`, not RBAC — a tenant OWNER cannot call them), UI: Mode column +
  `TenantModeDialog` on `/platform`.
- **Upgrade** (→ dual): sets the column, ensures the default Online channel (idempotent),
  audit `tenant.business_mode_changed` with previous/new value. Takes effect on the
  tenant's next request (the mode is read with the session, no caching).
- **Downgrade** (→ online-only): **refused** if the tenant owns any *document* —
  `Sale`, `SaleReturn`, `Reception` or `SupplierPayment` — because those are ledger-linked
  records that would become invisible but still affect stock and balances. Purely
  configurational data (store channels, barcodes, suppliers with no documents) does not
  block; it is kept untouched and merely inert, and re-upgrading restores it as it was.
  The preview reports the reason and the informational counts; nothing is ever deleted.
- Same-mode changes and unknown tenants are refused.

## Rejected alternatives
- **Feature flags per permission / per page**: N flags to keep consistent; the
  capability layer is 5 named families with one mapping table.
- **A new role for "online only"**: the axis is per tenant, not per user, and would
  not stop OWNER/ADMIN from reaching Offline surfaces.
- **Hiding UI only**: every rule above is enforced on the server; the UI merely reads
  the same capabilities.
- **Deleting Offline data on downgrade**: destructive and unrecoverable; refusal +
  inert configuration is safer and reversible.
- **Reusing plan entitlements**: plans are commercial and per-usage (ADR 0035); the
  mode is an operator provisioning decision and must not depend on billing state.

## Consequences / known limits
- Test posture: `resetDb()` sets `ONLINE_ONLY`; `setTestBusinessMode("ONLINE_AND_OFFLINE")`
  opts a suite in. New Offline tests must do so.
- Adding a permission that belongs to an Offline capability requires an entry in
  `PERMISSION_CAPABILITY`; `tests/lib/business-mode.test.ts` pins the exact gated list
  so an accidental gate (or omission) fails CI.
- Existing tenants that already used A–G features on a preview/dev database would be
  reset to `ONLINE_ONLY` by the backfill; a platform admin must upgrade them. (No
  production tenant has A–G data — nothing from ADR 0038–0040 has been deployed.)
- There is no self-service mode switch for a tenant, and the mode is not exposed on the
  tenant's own Abonnement page.
