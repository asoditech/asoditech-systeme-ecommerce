# ADR 0027 — Tenant provisioning & user management (Phase 5)

## Status
Accepted (2026-09-07)

## Context
Phases 1-4 (ADR 0023-0026) made tenant isolation real, at both the
application and database layers — but every tenant still had to be created
by hand, directly in the database, with a manually-hashed password for its
first user. There was no way for an actual operator to bring up a new
tenant, no way for a tenant's own admin to add or remove teammates without
shell access, and no self-service path to recover a forgotten password.
User creation (`createUserAction`) also had a real weakness independent of
multi-tenancy: an OWNER chose the new user's initial password directly, so
it necessarily passed through a request body / server action in plaintext
and had to be relayed to the new user out-of-band by the OWNER themselves.

This phase closes that gap: tenant lifecycle, invitation-based user
provisioning, and self-service password reset — all tenant-isolation-aware
by construction, reusing Phases 1-4's context/RLS stack rather than
introducing a parallel scoping mechanism.

## Decision

### 1. `isPlatformAdmin` — a flag, not a role
The `/platform` area (create/activate/suspend *other tenants*) is the one
surface in this app that legitimately operates across tenants. It is
gated by a new boolean, `User.isPlatformAdmin`, deliberately **outside**
`ROLE_PERMISSIONS` (`src/lib/auth/permissions.ts`) and RBAC entirely —
being OWNER of a tenant grants nothing here. Two reasons this is a flag
and not a role:
- The task explicitly kept RBAC static (no custom role builder) — adding
  an cross-tenant "PLATFORM" role would have meant either a ninth role
  members can be assigned inside a tenant (wrong: it isn't tenant-scoped)
  or a role that exists outside the `UserRole` enum's tenant-scoped
  meaning entirely (confusing: two different things sharing one column).
- It composes independently of tenant membership: the bootstrap tenant's
  OWNER is a platform admin today (see §5's backfill) purely because
  there is no other operator yet, not because OWNER-ness implies it.

`requirePlatformAdmin()` / `requirePlatformAdminForAction()`
(`src/lib/auth/guards.ts`) are the only two guards that check it; every
other guard in the app is unchanged. `/platform` is its own route group
(`src/app/platform/layout.tsx`), not nested under `(protected)` — it has
its own header/shell and doesn't want the tenant-scoped app chrome.

### 2. Invitation-only provisioning, everywhere, including a tenant's first user
`createUserAction` (admin-chosen password) is **removed**, not
deprecated. Every user, in every tenant — including a brand-new tenant's
first OWNER — now exists only by accepting an `Invitation`: a tenant-
scoped row (`email`, `name`, `role`, `tokenHash`, `status`, `expiresAt`,
`invitedById`) carrying a secure one-time token, 7-day TTL
(`INVITATION_TTL_MS`), single-use (`status: PENDING → ACCEPTED`, or
`→ REVOKED`).

This creates a chicken-and-egg question for a **brand-new** tenant:
nobody is a member yet to invite its first user. `createTenantAction`
(`src/actions/tenants.ts`) resolves it by creating the `Tenant` row and an
`OWNER`-role `Invitation` for it in one action — the platform admin isn't
a member of the new tenant, so the invitation is created via
`runWithTenant(tenant.id, ...)`, scoping just that one write to the new
tenant even though the actor's own session tenant is different. This is
the only place in the app a Server Action deliberately runs a write
against a tenant other than the actor's own — safe specifically because
`requirePlatformAdminForAction()` gates the whole function, and the write
is a fixed, narrow shape (one OWNER invitation), not an open-ended
cross-tenant operation.

`inviteUserAction` (`src/actions/invitations.ts`) is the ordinary path —
`users.manage` permission, scoped automatically to the actor's own tenant
by the Phase 2-4 stack, no explicit `tenantId` check needed anywhere in
the file. One extra guard mirrors `updateUserRoleAction`'s existing
privilege-escalation check: only an OWNER may invite another OWNER. A new
invitation revokes any prior `PENDING` one for the same email (at most one
live token per address at a time) — scoped by the app-level extension, so
this can never reach into another tenant's pending invitation for the
same address (adversarially tested — see Consequences).

### 3. One secure-token mechanism, shared by sessions, invitations, and password resets
`src/lib/auth/tokens.ts` extracts what `session.ts` already did (256-bit
random, `base64url`, only the HMAC-SHA256 hash — keyed by `AUTH_SECRET` —
ever persisted) into `generateRawToken()`/`hashToken()`, now shared by
`Invitation.tokenHash` and the new `PasswordResetToken.tokenHash`. Both
token tables are looked up **unscoped**
(`src/lib/auth/token-lookup.ts` — `findUsableInvitation`/
`findUsablePasswordResetToken`, via `runUnscoped` + `prismaBase`): the
tenant isn't known until the token itself resolves one, exactly like
login's email lookup (ADR 0025). These two helpers are shared by both the
accept/reset Server Action (acts on the token) and the corresponding page
component (previews it server-side before rendering a form, so an
expired/revoked/already-used link shows a clear error immediately instead
of a form that fails on submit).

### 4. Password reset — same token mechanism, shorter TTL, two entry points
- **Self-service** (`requestPasswordResetAction`, public, no session):
  looks up every ACTIVE user matching the email **across every tenant**
  (`runUnscoped` — email is unique per tenant, not globally, ADR 0025;
  the same address can have an independent account in more than one),
  issues an independent token per match, and **always** returns the same
  generic response — never reveals whether the email matched, in which
  tenant, or how many times. No transactional email is wired up (out of
  scope, unchanged from ADR 0003's original call); the link is logged
  server-side (`console.log`) as a stand-in for a real send.
- **Admin-initiated** (`adminResetPasswordAction`, `users.manage`,
  scoped to the actor's own tenant automatically): hands the raw link
  straight back to the caller instead of emailing anything — no
  enumeration risk to guard against, since the admin already has
  legitimate access to that user's account.

1-hour TTL (`RESET_TOKEN_TTL_MS`), shorter-lived than an invitation's 7
days — a password reset is a live account being taken over momentarily,
not a fresh signup. Completing a reset destroys every one of the user's
existing sessions (`destroyAllSessionsForUser`).

### 5. Tenant lifecycle — activate/suspend, immediate hard lockout
`activateTenantAction`/`suspendTenantAction` are plain status flips, both
`requirePlatformAdminForAction`-gated. Suspending is deliberately not
just "new logins fail": it calls `destroyAllSessionsForTenant` in the
same action, revoking every existing session for every one of that
tenant's users immediately. `getCurrentUser()` (`src/lib/auth/session.ts`)
also independently checks the tenant's status on every request — a
session created in the narrow gap before the mass-revoke runs is still
rejected. The bootstrap tenant (`id === "default"`) can never be
suspended (`suspendTenantAction` rejects it outright) — there's no
platform-admin account left to reactivate it if it were ever cut off from
itself.

Migration backfill: `UPDATE users SET "isPlatformAdmin" = true WHERE
"tenantId" = 'default' AND role = 'OWNER'` — until real platform
provisioning exists beyond this phase, the bootstrap tenant's own OWNER
is also the platform operator (mirrored in `prisma/seed.ts`'s bootstrap
OWNER, which now also sets `isPlatformAdmin: true`).

### 6. `UserRole.SALES` → `UserRole.CONFIRMATION`
Purely a label fix (the role governs order-confirmation work, not sales)
— **zero** behavioral change to `ROLE_PERMISSIONS`. The migration uses a
single hand-written `ALTER TYPE "UserRole" RENAME VALUE 'SALES' TO
'CONFIRMATION'` instead of the generic diff Prisma would otherwise emit
for an enum change (create a new type, cast every row through `::text`,
swap, drop the old type) — that generic form treats a rename as "remove
one label, add another", and its `USING ("role"::text::"UserRole_new")`
cast **fails outright** for any existing `'SALES'` row, since `'SALES'`
isn't a member of the replacement type. `RENAME VALUE` is the correct
primitive for a pure rename: every existing row's value (stored as the
enum's internal ordinal, never the text label) is completely unaffected,
and so is the column's `DEFAULT` — no `DROP`/`SET DEFAULT` needed either,
unlike the generic diff. Verified directly against a production-shaped
two-tenant clone carrying `SALES` rows (see Consequences).

### 7. RLS on the two new tables, identical shape to every other one
`invitations` and `password_reset_tokens` both carry `tenantId` (default
`"default"`, same convention as every Phase 1 table) and get the exact
same `ENABLE`/`FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy as
every other tenant-scoped table (ADR 0026) — no special-casing needed
anywhere in the RLS stack, since both models were picked up automatically
by the DMMF-driven `tenantId`-field scan the whole Phase 2-4 stack already
uses. `tokenHash` is globally unique on both (it's the lookup key *before*
any tenant is known — see §3), which is the one column on either table
that is intentionally NOT tenant-scoped.

## What this explicitly does NOT do
No billing/licensing, no Phase 6 work of any kind. No custom role
builder — the eight `UserRole` values are still static, unchanged in
shape (§6 is a rename, not a new role). No tenant switcher for a user
belonging to more than one tenant (out of scope; a person with accounts
in two tenants today has two independent sessions, exactly like the
pre-existing shared-email-across-tenants login behavior in ADR 0025). No
real email delivery — every link (invitation and password reset) is
returned to the caller / logged server-side, not sent.

## Consequences
- **`createUserAction` is gone.** Every account, in every tenant, is now
  created only by accepting an `Invitation` — verified by the full
  `tests/actions/users.test.ts` rewrite (OWNER **and** ADMIN, not
  OWNER-only, may manage users; the "cannot touch another OWNER" absolute
  guards are unchanged) and the new `tests/actions/invitations.test.ts`.
- **New adversarial coverage**
  (`tests/actions/invitations.test.ts`,
  `tests/actions/password-reset.test.ts`, `tests/actions/tenants.test.ts`):
  a tenant admin can neither see nor revoke another tenant's invitations;
  the same email can be independently invited in two different tenants
  and each resolves independently; an accepted invitation creates the
  user in the invitation's own tenant, never the inviter's tenant, even
  when a platform admin creates it on a brand-new tenant's behalf; an
  invitation/reset token is single-use, expiring, and rejected once its
  tenant is suspended; a password-reset token minted for one tenant's
  user cannot touch a same-email user in another tenant; a plain OWNER
  (not a platform admin) is rejected by every `/platform` action just as
  hard as any other role; suspending a tenant destroys its users'
  sessions and independently blocks a session created afterward;
  reactivating restores login.
- **Migration verified**: applies cleanly to both local databases;
  `prisma migrate diff --to-schema-datamodel --exit-code` reports no
  drift; and — the same methodology as ADR 0026 — against a
  production-shaped clone seeded with two tenants, `SALES`-role users in
  each, and more than one `OWNER`: zero data loss, every `SALES` row
  correctly reads `CONFIRMATION` afterward, and the platform-admin
  backfill touched only the bootstrap tenant's `OWNER`, not the other
  tenant's.
- **`resetDb()` gained two more tables to wipe**
  (`tests/helpers/db.ts`): `invitations` has a `RESTRICT` fk to `tenants`,
  so a leftover row would have blocked the existing non-default
  `tenant.deleteMany` between tests.
- Full suite green against the migrated schema: 873 pre-existing tests
  unmodified (aside from the `SALES`→`CONFIRMATION` string in fixtures)
  plus new Phase 5 coverage, `tsc --noEmit` and `eslint` clean, `next
  build` clean.
