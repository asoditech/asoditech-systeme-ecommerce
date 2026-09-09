# ADR 0034 — Backup & Portability (Phase 1: the backup engine)

## Status
Accepted (2026-09-10). Builds on ADR 0023–0027 (multi-tenant foundation /
context / isolation / RLS / provisioning), ADR 0004 (integration
architecture), ADR 0032 (delivery cost rules — recorded values are what a
backup carries).

## Context

Each tenant's business data lives in one Postgres/Supabase database. That
database is the **source of truth** and is itself backed up at the
infrastructure level. What did not exist is a way for a **tenant** to, on
their own, take a portable, verifiable copy of **only their own** data —
to keep off-platform, to move to another deployment later, or to roll back
a bad bulk change.

This ADR introduces an **independent module** for that. It changes nothing
about Orders, Stock, Delivery, Finance, RBAC or the multi-tenant
architecture. Its only schema footprint is one table.

```
Postgres / Supabase   ──►   SOURCE OF TRUTH  (infra-level backups)
        │
        ▼
ASODITECH Backup Service   ──►   encrypted .asb package   ──►   Download now
```

Phase 2 (Google Drive as a *destination*, never the source of truth) and
Phase 3 (scheduled backups + retention) are **out of scope here** and are
deliberately not built. The engine is shaped so they slot in without a
rewrite.

## Why a separate backup, not "just use Postgres/Supabase backups"

- Infra backups are **whole-database**, operator-only, and not
  tenant-scoped — a tenant cannot self-serve, and restoring one would
  affect every tenant.
- They are tied to the provider and the exact schema version.
- They contain **every secret** (password hashes, encrypted credentials).
- A tenant moving to a different ASODITECH deployment cannot use them.

An `.asb` package is tenant-scoped, secret-free, versioned, self-describing
(manifest), and authenticated-encrypted.

## Why Google Drive is NOT the source of truth (and not in Phase 1)

Drive would be a *replication target* — a convenience so a backup lands
somewhere off-platform automatically. It is never authoritative: it can be
disconnected, its contents can be deleted or altered by the account owner,
and it introduces an OAuth secret and a third-party dependency into the
backup path. Phase 1 keeps the whole path inside ASODITECH
(generate → encrypt → download). Phase 2 adds Drive as an *optional extra
copy* of the same `.asb` package, with the DB still the source of truth.

## Package format

`ASODITECH_BACKUP_<slug>_<YYYY-MM-DD>.asb` — a binary container:

```
[0..3]   magic "ASB1"
[4]      container version (1)
[5]      reserved
[6..17]  AES-256-GCM IV (12 bytes)
[18..33] AES-256-GCM auth tag (16 bytes)
[34..]   ciphertext = AES-256-GCM( gzip( utf8 JSON ) )      AAD = bytes [0..5]
```

The plaintext JSON is `{ manifest, data }`:

- `data` — `{ "<table>": [ …rows… ] }`, one key per exported model, rows
  exactly as Prisma returns them (`Decimal` → string, `Date` → ISO string
  via their own `toJSON`).
- `manifest`:

```jsonc
{
  "format": "ASODITECH_BACKUP",
  "version": 1,                       // FORMAT version — restore refuses an unknown one
  "appVersion": "0.1.0",
  "schemaVersion": "20260910000000_backup_portability",   // latest applied migration, best-effort
  "createdAt": "2026-09-10T…Z",
  "createdByUserId": "…" | null,
  "tenant": { "id": "…", "slug": "…", "name": "…" },
  "counts": { "products": 0, "orders": 0, … },
  "totalRows": 0,
  "checksum": { "algo": "sha256", "data": "<hex of canonical JSON(data)>" },
  "encryption": { "algo": "AES-256-GCM", "keyId": "backup" | "integration" },
  "policy": { "sanitizedFields": {…}, "excludedModels": {…}, "idStrategy": "preserve-ids; reassign-tenantId-only" }
}
```

### Versioning

`BACKUP_FORMAT_VERSION` is bumped only on a breaking change to the package
layout or model set. `SUPPORTED_BACKUP_FORMAT_VERSIONS` lists every version
this build's restore engine reads; an out-of-range version is rejected at
inspection, before anything is touched.

## Encryption / key management

- **AES-256-GCM**, authenticated. The 6-byte header is the GCM AAD, so a
  tampered header fails authentication. The manifest additionally carries a
  SHA-256 of the canonical `data` JSON — an independent, recomputable
  integrity check the restore engine verifies before touching the DB.
- Key: **`BACKUP_ENCRYPTION_KEY`** (base64 32 bytes) when set, else
  **`INTEGRATION_ENCRYPTION_KEY`** (always present). Never hard-coded,
  never derived from a constant. `manifest.encryption.keyId` records which
  was used, so a future two-key rotation can pick the right one.
- **Operational requirement:** a deployment that relies on backups MUST set
  a dedicated `BACKUP_ENCRYPTION_KEY` and keep it backed up **outside the
  database**. A lost key makes every existing `.asb` package unrecoverable.
  Rotating it does not re-encrypt old packages — keep the previous key
  until every package made with it is gone.

## Exactly what a backup contains

Exported (tenant-scoped models, dependency order — see
`src/lib/backup/models.ts`): `users` (sanitized), `business_settings`,
`customers`, `customer_addresses`, `categories`, `products`,
`product_images`, `product_variations`, `warehouses`, `inventory_items`,
`marketing_channels`, `marketing_campaigns`, `commission_agents`,
`commission_statements`, `shipping_providers` (sanitized),
`delivery_city_mappings`, `delivery_manifests`, `orders`, `order_items`,
`order_confirmation_attempts`, `refunds`, `shipments` (incl. tracking
history — ADR 0033 columns), `stock_transfers`, `stock_transfer_lines`,
`stocktake_sessions`, `inventory_movements`, `stocktake_lines`,
`commission_entries`, `expense_categories`, `expenses`, `integrations`
(sanitized), `audit_events`.

### Excluded, with reason

| Model | Why excluded |
|---|---|
| `Session` | auth tokens — ephemeral, never portable |
| `Invitation` | contains a secret token hash — ephemeral provisioning state |
| `PasswordResetToken` | contains a secret token hash — ephemeral |
| `Notification` | ephemeral in-app UI state, regenerated by events |
| `WebhookEvent` / `ShipmentWebhookEvent` | replay-protection dedupe logs — meaningless after reconnect |
| `SyncRun` | integration run history — meaningless after reconnect |
| `Tenant` | the tenant identity itself — a backup is restored *into* an existing tenant |
| `BackupRun` | the module's own bookkeeping — never backs itself up |

### Sensitive fields stripped (never in a package)

| Model | Field(s) removed |
|---|---|
| `User` | `passwordHash`, `isPlatformAdmin` |
| `Integration` | `credentialsEncrypted` (+ `config` scrubbed of any credential-looking key) |
| `ShippingProvider` | `credentialsEncrypted` (+ `config` scrubbed) |

Also never present, by virtue of the excluded models: password-reset,
invitation and session token hashes. There is no code path that writes a
secret VALUE into the manifest.

**After restore, every connector requires reconnection**: `Integration`
comes back `DECONNECTE` with `credentialsEncrypted = null`;
`ShippingProvider` comes back with `connectionStatus = DECONNECTE` and no
credentials.

## Tenant isolation

- **Export** runs entirely inside `runWithTenant(tenantId, "backup:export")`
  using the tenant-scoped `prisma` client. Every read is constrained by the
  Phase 2 extension AND the Phase 4 RLS policy — there is no cross-tenant
  code path to get wrong.
- **`backup_runs`** is a tenant-scoped table with the same RLS policy shape
  as every other one: a tenant can only ever see or write its own rows.
- **Restore** refuses `manifest.tenant.id !== activeTenantId`
  (`CrossTenantRestoreError`). Cross-tenant / cross-deployment restore is a
  Phase-1 non-goal.
- **RBAC**: viewing and using the module require `settings.manage`
  (OWNER / ADMIN — see `src/lib/auth/permissions.ts`). Enforced in the
  page, in both Route Handlers, and in every Server Action.

## Restore strategy & safety

Flow (`src/lib/backup/service.ts` → `import.ts`):

1. **Upload** (`POST …/restore/upload`, multipart) → decrypt + authenticate
   + verify the `data` checksum + validate the manifest. A valid package is
   held server-side as a `RESTORE_UPLOAD` row (1-hour TTL); an invalid one
   is stored too, so the preview can show *why* it was rejected.
2. **Preview** — the UI shows origin tenant, dates, versions, per-model
   counts and any warnings, and requires an **explicit** "Restaurer
   maintenant".
3. **Safety snapshot** — `runRestore` first generates a full
   `PRE_RESTORE_SNAPSHOT` of the tenant's *current* data (7-day TTL,
   downloadable) — a bad restore is always recoverable.
4. **Transactional restore** — one `runWithTenant` + one `$transaction`:
   - wipe every `strategy: "replace"` model (child-first);
   - re-insert in dependency order; `createMany` per model, `null` values
     dropped so optional JSON columns fall to their default;
   - **second pass** patches deferred foreign keys — `Category.parentId`
     (self), `InventoryMovement.{orderId,stockTransferId,stocktakeSessionId}`,
     `StocktakeLine.appliedMovementId`;
   - **verify** every replaced model's row count equals the package's —
     any mismatch throws and the whole transaction **rolls back**.
5. On success the upload is marked `RESTORED` and its payload dropped; on
   any failure it is marked `FAILED`, `backup.restore_failed` is audited,
   and **nothing changed** (the safety snapshot is still there).

### Never touched destructively

- **User accounts are merged, never deleted** (lockout risk). Matched by
  `(tenantId, email)`: an existing account has only `name`/`role`/`status`
  refreshed — `passwordHash` and `isPlatformAdmin` are never touched. A
  backup account with no local match is created **login-disabled**
  (`passwordHash = ""`, `status = DISABLED`) so FK integrity holds; an
  OWNER must re-invite / reset it.
- **`BusinessSettings`** is upserted (one row per tenant).
- **The audit trail is never wiped** — backup audit rows not already
  present (by id) are appended; a `backup.restored` event is added.

### IDs — what is preserved, what is remapped

- **Every record ID is preserved verbatim** (they are cuids — globally
  unique by construction). This keeps all relationships intact on a
  same-tenant restore.
- **Only `tenantId` is (re)assigned** — stripped from every row on the way
  in and re-stamped by the tenant extension to the active tenant. This is
  the single hook a future cross-tenant/cross-deployment restore needs.
- Autoincrement identity columns (`Order.orderNumber` etc.) are preserved.
  On a *different* deployment these could collide — hence cross-deployment
  restore is explicitly deferred; the format itself is ready for an
  ID-remapping restore mode.

## Performance

- No backup work on any normal page request. No Prisma middleware. The
  module's only always-on cost is the `backup_runs` table existing.
- Generation and restore are **synchronous, in memory**, bounded by
  `MAX_TOTAL_ROWS` (100 000) and `MAX_CONTAINER_BYTES` (25 MiB sealed). A
  tenant past either is told to wait for the background-job phase rather
  than risk a half-applied restore or a serverless timeout.
- `src/lib/backup/models.ts` is a declarative, ordered catalogue — the
  export/restore engines iterate it. A future streaming/chunked rewrite
  (per-model cursor pagination, NDJSON body) changes only the engines, not
  the container format or the manifest.
- Stored payloads are pruned: the latest `MANUAL_EXPORT` replaces the
  previous one; `RESTORE_UPLOAD` payloads are nulled once consumed;
  `PRE_RESTORE_SNAPSHOT` rows carry a TTL (automatic pruning is a Phase-3
  concern — for now they age out of usefulness and can be deleted).

## Files

**Schema**: `prisma/schema.prisma` (+ `BackupRun` model, `BackupRunType` /
`BackupRunStatus` enums, `Tenant.backupRuns`, `User.backupRunsCreated`);
`prisma/migrations/20260910000000_backup_portability/migration.sql` (one
table + its RLS policy).

**Engine** (`src/lib/backup/`): `constants.ts`, `models.ts`,
`container.ts`, `manifest.ts`, `export.ts`, `import.ts`, `service.ts`.

**Read model**: `src/lib/queries/backup.ts`.

**Actions / routes**: `src/actions/backup.ts`;
`src/app/(protected)/parametres/sauvegarde/download/route.ts`;
`src/app/(protected)/parametres/sauvegarde/restore/upload/route.ts`.

**UI**: `src/app/(protected)/parametres/sauvegarde/page.tsx`;
`src/components/settings/backup-panel.tsx`;
`src/components/settings/settings-nav.tsx`; a nav link added to
`src/app/(protected)/parametres/page.tsx`.

**Misc**: `src/lib/env.ts` (+ optional `BACKUP_ENCRYPTION_KEY`),
`.env.example`, `src/lib/audit.ts` / `src/lib/audit-labels.ts`
(`backup.*` actions).

## Future work (NOT in this ADR's scope)

- **Phase 2** — Google Drive as an optional replication *target* for the
  same `.asb` package (OAuth per tenant; DB stays the source of truth).
- **Phase 3** — scheduled backups + retention policy + pruning job.
- Cross-tenant / cross-deployment restore (ID-remapping mode).
- Background-job generation for tenants past the synchronous caps.
- Selective / partial restore (single module).
