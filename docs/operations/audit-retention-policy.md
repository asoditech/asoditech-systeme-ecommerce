# Audit-event retention policy

**Status:** agreed policy — **documented only, not implemented.** Nothing deletes
or archives `audit_events` today. Last updated: 2026-10.

## Why

`audit_events` is append-only and grows with every audited action. Business
history must stay intact — the application reads it for order history, transfer
history, stocktake history, the audit journal (`/journal-audit`), the dashboard's
« Activité récente » and the platform's per-tenant « last activity ». Technical
events must not turn it into a dumping ground.

## Retention by class

| Class | Examples | Retention |
|---|---|---|
| **Business critical** | `order.*`, `inventory.*`, `stock_transfer.*`, `stocktake.*`, `sale.*`, `reception.*`, `supplier*`, `shipment.created / status_changed / cancelled / deleted / cost_overridden`, `delivery_manifest.created`, `commission.*`, `expense*`, `customer.*`, `product.*` (except `exported`), `category.*`, `warehouse.*` | **At least 5 years. Never deleted directly** — a future archive strategy moves them out of the hot table. |
| **Security — sign-ins** | `user.login.success`, `user.login.failure`, `user.logout` | **24 months** |
| **Security — access changes** | `user.created / role_changed / status_changed / deleted / permissions_updated / locations_updated / channels_updated`, `invitation.*`, `tenant.*`, `platform.unlock.*` | **5 years** |
| **Security — password / data** | `password_reset.*`, `user.password_reset_forced`, `backup.downloaded`, `backup.restored / restore_failed / restore_previewed` | **5 years** (long-term security retention) |
| **Important configuration** | `settings.updated`, `integration.connected / disconnected / updated`, `shipping_provider.*` (except connection tests), `delivery_city_mapping.*`, `sales_channel.*`, `marketing_*`, `plan.*`, `subscription.*`, `announcement.*`, `backup.created`, `backup.drive_connected / disconnected / uploaded / deleted` | **5 years** |
| **Technical** | the list in `src/lib/audit-classification.ts` (`TECHNICAL_AUDIT_ACTIONS`): sync runs, connection tests, tracking refreshes, carrier / Drive failures, `ai.query`, `usage.threshold_reached`, `support.ticket_created`, `product.exported` | **6 months** initially |

`integration.webhook_received` is **no longer written** (stopped 2026-10): each
delivery is already recorded in `webhook_events`, and its business effect is
audited separately (`order.created`, `product.*`). Existing rows are technical.

## Already in place

- The dashboard « Activité récente » hides technical and routine sign-in events
  (`DASHBOARD_HIDDEN_AUDIT_ACTIONS`); the audit journal still shows everything.
- `cleanupExpiredEphemeralData()` (`src/lib/maintenance/expired-data.ts`) can
  delete expired sessions, password-reset tokens and Google OAuth states. **It is
  not scheduled** — no scheduler exists yet; a protected route + Vercel Cron (new
  secret env variable) is the expected trigger, to be decided.

## Prerequisites before implementing audit retention

1. **Backup restore must respect retention.** The restore re-appends every
   `audit_events` row of the package that is not already present
   (`appendAudit` in `src/lib/backup/models.ts` / `import.ts`); otherwise a
   restore can reintroduce previously-retained/deleted audit rows. The restore
   must skip rows older than the policy allows for their class.
2. **Platform « last activity »** (`src/lib/queries/platform.ts`) uses the most
   recent audit event per tenant. Base it on session use (`sessions.lastUsedAt`)
   before sign-in events are pruned, or it will under-report activity.
3. Deletion must run per class, in batches, unscoped (all tenants), and be
   idempotent — the same pattern as `cleanupExpiredEphemeralData()`.
4. Business-critical rows are archived, never purged.
