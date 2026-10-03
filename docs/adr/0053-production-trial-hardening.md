# ADR 0053 — Production trial hardening (tenant context, platform access, trial purge)

## Status
Accepted (2026-10-01). Minimal changes on top of the existing multi-tenant
architecture (tenantId + Prisma tenant extension + Postgres RLS, ADRs
0023–0027). No schema change, no migration, no new permission.

## R1 — no audit event in a foreign tenant
Before: an unattributable failed login and a webhook whose signature matched
no integration were written to the **bootstrap tenant's** audit journal — the
typed e-mail, and sometimes another tenant's user id, became visible to that
customer.

Now:
- A failed login is audited **only in the tenant(s) that own an account with
  that e-mail**, each row naming that tenant's own user.
- An e-mail matching no account, and a rejected webhook, belong to no tenant:
  **server log only** (`[auth] …`, `[webhook] …`), never a customer journal,
  and the log line does not contain the e-mail.

There is no platform-level audit table; adding one would need a migration and
was not required to remove the leak.

## R2 — fail-closed tenant context
`resolveActiveTenant` (reads, updates, deletes) now **throws
`TenantContextRequiredError`** when there is neither an explicit
`runWithTenant`/`runUnscoped` directive nor a session — exactly like creates
already did. The bootstrap fallback survives only under `NODE_ENV=test`.

The one runtime path that relied on the fallback,
`checkAndNotifyUsageThreshold` (called from invitation acceptance and the
webhooks, before/without a session), now pins its own tenant.

Verified in a production build (`next start`, NODE_ENV=production) by
crawling all 56 static app pages as 4 roles plus the public pages: no
tenant-context error.

Also: `readSessionToken` imports `next/headers` statically. The dynamic import
could, under vitest, resolve to the real (unmocked) module inside a
`Promise.all`, which hid cross-tenant tests behind the bootstrap fallback.

## R3 — production database role (manual check, cannot be done from code)
RLS only protects anything if the runtime role is neither superuser, table
owner, nor `BYPASSRLS`. The repo cannot read the production secrets
(Sensitive in Vercel). Run in the Supabase SQL editor, or with `psql` using
the **runtime** `DATABASE_URL` (strip `?schema=public&pgbouncer=true` for psql):

```sql
SELECT current_user, r.rolsuper, r.rolbypassrls
FROM pg_roles r WHERE r.rolname = current_user;          -- expect f, f
SELECT tableowner FROM pg_tables WHERE tablename = 'orders';  -- must NOT be current_user
SELECT count(*) FROM orders;                              -- expect 0 (no tenant GUC = default-deny)
```

Expected: the runtime role (`asoditech_app` per
`scripts/provision-production-role.sql`) returns `rolsuper = f`,
`rolbypassrls = f`, is not the owner, and sees **0** orders without the
tenant setting. If `current_user` is `postgres` (or anything with
`rolbypassrls = t`), RLS is NOT enforcing in production: provision the role
with `scripts/provision-production-role.sql`, point `DATABASE_URL` at it, and
verify with `scripts/verify-rls.sh`. `DIRECT_URL` (migrations) stays the
owner role.

## Platform owner access — step-up key
`/platform` (every customer's lifecycle, plan, data) now requires, on top of
`User.isPlatformAdmin` and a normal login, a **Platform Access Key**:

- **Key:** a long random secret held only by the owner.
- **Storage:** the deployment stores only its SHA-256 in
  `PLATFORM_ACCESS_KEY_SHA256` (64 hex characters). It is never in the
  database, the source code, the client bundle or the logs.
- **Unlock:** at `/acces-plateforme`. The unlock is an httpOnly, SameSite=strict
  cookie, HMAC-signed with `AUTH_SECRET` and bound to the user, their current
  session and the key hash. It lasts at most 8 h. « Verrouiller » ends it, and
  so does logging out.
- **Enforced server-side:** `requirePlatformAdmin` (every `/platform` page) and
  `requirePlatformAdminForAction` (every platform Server Action).
- **Fail-closed:** in production, with no valid hash configured, `/platform`
  is locked for everyone. Locally and in tests, with no hash configured, the
  step-up is skipped.
- **Audited:** each unlock attempt is recorded (success or failure) in the
  admin's own tenant, never the key.

Setup and rotation (owner):
```bash
node -e 'const c=require("crypto");const k=c.randomBytes(32).toString("base64url");console.log("KEY (store in your password manager):",k);console.log("PLATFORM_ACCESS_KEY_SHA256="+c.createHash("sha256").update(k).digest("hex"))'
```
Put only the hash in Vercel (Production), and redeploy. To rotate, generate a
new pair and redeploy: every existing unlock is invalidated. Recovery = whoever
controls the Vercel project's environment variables generates a new pair.

`listTenantsForPlatform` (previously unguarded, only used by tests) is now
behind the same guard.

## Customer passwords
Unchanged and already sound:
- Passwords are bcrypt-hashed.
- Reset tokens are HMAC-hashed, expire after 1 h, are single-use, and using
  one ends every session.
- Nothing shows a password.

New: **« Forcer la réinitialisation »** (platform owner, `/platform/utilisation?tenant=…`):
- the password hash is replaced by the hash of a random secret nobody knows;
- every session is ended;
- the standard reset link is e-mailed to the user;
- the action is audited in the user's own tenant.

It is refused for platform-admin accounts. It requires working e-mail delivery
(`RESEND_API_KEY`, `EMAIL_FROM`); the tenant's own admin can also issue a
reset link from `/utilisateurs`.

## Active / disabled customers
Unchanged: `Tenant.status = SUSPENDED` (platform « Suspendre ») blocks login
and every existing session; re-activating restores access.

## Trial purge
The existing tenant deletion is hardened, not duplicated:
- **Trial only:** the tenant's subscription must be `TRIALING` (the existing
  lifecycle, ADR 0035; set from `/platform/plans`). A regular customer is
  refused, as are the bootstrap tenant and any tenant holding a platform-admin
  account.
- **Dry-run:** opening the dialog counts every tenant-owned row, enumerated
  from the schema, without writing anything.
- **Confirmation:** the tenant's slug must be typed.
- **One transaction**, in dependency order. Physical order returns are now
  deleted first; before, a single return made deletion impossible.
- **Zero-row proof before commit:** every tenant-owned table must be empty for
  that tenant, otherwise everything rolls back.
- **Never touched:** other tenants, `plans`, and the platform admin.

## Customer usage
`/platform/utilisation` shows, per customer:
- users, products, variations, locations, stock items, orders, store sales,
  customers, suppliers, receptions, shipments and returns;
- growth over the last 30 days (orders, sales, stock movements);
- last activity, creation date, status, plan and subscription;
- each customer's users.

It also shows the most-used modules across all customers, and the **real**
database size and largest tables (Postgres catalog). Per-customer size is
shown as row counts — Postgres cannot measure bytes per tenant, and no
estimate is invented.

Cost: one `GROUP BY tenantId` per table, cached 5 minutes in process
(« Actualiser » recomputes).
