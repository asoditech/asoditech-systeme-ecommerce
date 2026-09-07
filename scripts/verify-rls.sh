#!/usr/bin/env bash
# Proves Postgres RLS actually blocks cross-tenant access on a REAL
# database, connecting as the restricted runtime role (never a
# superuser) — the same role DATABASE_URL must use. Safe to run against
# production: everything runs inside one transaction that is always
# ROLLBACK'd, so no row (not even the two scratch tenants/users this
# creates to test with) is ever actually committed.
#
# Usage:
#   APP_ROLE_URL="postgresql://asoditech_app:<password>@host:5432/db" \
#     ./scripts/verify-rls.sh
#
# APP_ROLE_URL must point at the restricted role from
# scripts/provision-production-role.sql — connecting as a superuser or
# the table owner here would make every check below pass even if RLS is
# completely broken, defeating the point.

set -euo pipefail

if [[ -z "${APP_ROLE_URL:-}" ]]; then
  echo "APP_ROLE_URL is required — set it to the restricted role's connection string." >&2
  exit 1
fi

# Written to a temp file rather than piped via a heredoc inside a $(...)
# command substitution — macOS's default /bin/bash (3.2, GPLv2-licensed,
# still the system default) mis-parses a heredoc containing unbalanced
# parentheses when nested inside $(...); a plain -f avoids the whole
# class of quoting trap and matches how scripts/provision-production-role.sql
# is already run.
SQL_FILE="$(mktemp -t verify-rls).sql"
trap 'rm -f "$SQL_FILE"' EXIT

cat > "$SQL_FILE" <<'SQL'
BEGIN;

-- 1. No GUC set at all: must see zero rows on a real tenant-scoped table.
SELECT CASE WHEN count(*) = 0 THEN 'PASS: no-GUC read sees zero rows'
            ELSE 'FAIL: no-GUC read saw ' || count(*) || ' row(s) - RLS is not enforcing' END
FROM users;

-- 2. Scratch tenants + one user each, inserted under their own GUC.
SELECT set_config('app.tenant_id', 'rlscheck-a', true);
INSERT INTO tenants (id,name,slug,status,"createdAt","updatedAt","nextOrderNumber","nextTransferNumber","nextStocktakeNumber")
VALUES ('rlscheck-a','RLS Check A','rlscheck-a','ACTIVE',now(),now(),1,1,1);
INSERT INTO users (id,"tenantId",email,name,"passwordHash",role,status,"createdAt","updatedAt")
VALUES ('rlscheck-user-a','rlscheck-a','rlscheck-a@example.invalid','A','x','OWNER','ACTIVE',now(),now());

SELECT set_config('app.tenant_id', 'rlscheck-b', true);
INSERT INTO tenants (id,name,slug,status,"createdAt","updatedAt","nextOrderNumber","nextTransferNumber","nextStocktakeNumber")
VALUES ('rlscheck-b','RLS Check B','rlscheck-b','ACTIVE',now(),now(),1,1,1);
INSERT INTO users (id,"tenantId",email,name,"passwordHash",role,status,"createdAt","updatedAt")
VALUES ('rlscheck-user-b','rlscheck-b','rlscheck-b@example.invalid','B','x','OWNER','ACTIVE',now(),now());

-- 3. As tenant B, tenant A's user must be invisible.
SELECT set_config('app.tenant_id', 'rlscheck-b', true);
SELECT CASE WHEN count(*) = 0 THEN 'PASS: tenant B cannot read tenant A''s user'
            ELSE 'FAIL: tenant B saw ' || count(*) || ' of tenant A''s row(s)' END
FROM users WHERE id = 'rlscheck-user-a';

-- 4. As tenant B, tenant B's own user must be visible (proves this
--    isn't just "RLS blocks everything").
SELECT CASE WHEN count(*) = 1 THEN 'PASS: tenant B can read its own user'
            ELSE 'FAIL: tenant B saw ' || count(*) || ' of its own row (expected 1)' END
FROM users WHERE id = 'rlscheck-user-b';

-- 5. As tenant B, an UPDATE targeting tenant A's user by id must affect
--    zero rows (not merely "return an error" - RLS makes the row simply
--    not match, same as if it didn't exist).
UPDATE users SET name = 'SHOULD NOT APPLY' WHERE id = 'rlscheck-user-a';
SELECT CASE WHEN cnt = 0 THEN 'PASS: cross-tenant UPDATE affected zero rows'
            ELSE 'FAIL: cross-tenant UPDATE affected ' || cnt || ' row(s)' END
FROM (SELECT count(*) AS cnt FROM users WHERE id = 'rlscheck-user-a' AND name = 'SHOULD NOT APPLY') t;

-- 6. Bypass GUC must see both tenants (proves prismaBase's mechanism
--    still works for legitimate cross-tenant reads).
SELECT set_config('app.bypass_rls', 'on', true);
SELECT CASE WHEN count(*) = 2 THEN 'PASS: bypass GUC sees both scratch users'
            ELSE 'FAIL: bypass GUC saw ' || count(*) || ' (expected 2)' END
FROM users WHERE id IN ('rlscheck-user-a', 'rlscheck-user-b');

ROLLBACK;
SQL

echo "Connecting as the restricted role and running the verification transaction (will ROLLBACK, nothing persists)..."
RESULT="$(psql "$APP_ROLE_URL" -v ON_ERROR_STOP=1 -X -q -t -f "$SQL_FILE")"

echo "$RESULT"

if echo "$RESULT" | grep -q "FAIL"; then
  echo ""
  echo "RLS VERIFICATION FAILED — do not treat this environment as production-ready." >&2
  exit 1
fi

echo ""
echo "All checks passed. Nothing was committed (transaction rolled back)."
