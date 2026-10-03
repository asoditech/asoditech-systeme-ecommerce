#!/bin/zsh
# R3 (docs/adr/0053) — one-shot: provision the restricted runtime role in
# PRODUCTION, then verify it. Run from the repo root, in YOUR terminal:
#   zsh scripts/r3-provision-and-verify.zsh
# Asks for the current DIRECT_URL (owner, runs migrations) and the current
# DATABASE_URL (only used as a template: same host/port/query, new user +
# password). Writes nothing but the role and its grants. Stops at the first
# failure; prints the NEW DATABASE_URL only when every check passed, for you
# to paste into Vercel (Production) — never into a chat. Results go to
# ~/prod-r3-*.out (no password in them).
set -u

read -s "DU?Production DIRECT_URL (owner): "; echo
read -s "CU?Production DATABASE_URL (current, template): "; echo
[[ -z "$DU" || -z "$CU" ]] && { echo "Both URLs are required."; exit 1; }
DU="${DU%%\?*}"
APP_ROLE=asoditech_app

fail() { echo "STOPPED: $1"; unset DU CU APP_PW NEW_URL PSQL_URL; exit 1; }

# 0. The DIRECT_URL connection must be the role that owns the migrations
#    (it runs `prisma migrate deploy` and owns the tables to grant on).
CONN_USER=$(psql "$DU" -X -A -t -c "select current_user") || fail "cannot connect with the DIRECT_URL."
MIG_OWNER=$(psql "$DU" -X -A -t -c "select tableowner from pg_tables where schemaname='public' and tablename='_prisma_migrations'") || fail "cannot read the migrations table."
echo "0. DIRECT_URL connects as '$CONN_USER'; migrations owner is '$MIG_OWNER'"
[[ -n "$MIG_OWNER" && "$CONN_USER" == "$MIG_OWNER" ]] || fail "the first URL is not the migrations owner (DIRECT_URL). Nothing was changed."
[[ "$CONN_USER" != "$APP_ROLE" ]] || fail "the first URL logs in as $APP_ROLE itself. Nothing was changed."

APP_PW=$(openssl rand -hex 32)   # hex: nothing to URL-encode

# 1. Provision (idempotent; re-running only resets the password + re-grants).
psql "$DU" -X -v ON_ERROR_STOP=1 -v app_role="$APP_ROLE" -v app_password="$APP_PW" -v migration_role="$MIG_OWNER" \
  -f scripts/provision-production-role.sql > ~/prod-r3-provision.out 2>&1 || fail "provisioning failed, see ~/prod-r3-provision.out"
echo "1. provisioned $APP_ROLE (grants + default privileges for $MIG_OWNER)"

# 2. New DATABASE_URL: same scheme/host/port/db/query as the current one, user and
#    password swapped and percent-encoded; Supabase "<role>.<project_ref>" kept.
#    scripts/build-role-url.py validates the template and refuses to print a URL
#    that does not round-trip (tests/scripts/build-role-url.test.ts).
NEW_URL=$(TEMPLATE_URL="$CU" APP_ROLE="$APP_ROLE" APP_PW="$APP_PW" python3 scripts/build-role-url.py) \
  || fail "could not build the new URL from the DATABASE_URL template (see the message above)."
# psql rejects Prisma-only query parameters (?pgbouncer=true): same URL without query.
PSQL_URL=$(TEMPLATE_URL="$CU" APP_ROLE="$APP_ROLE" APP_PW="$APP_PW" python3 scripts/build-role-url.py --no-query) \
  || fail "could not build the psql URL."

# Remove any trace of the password (raw or percent-encoded) from an output file.
scrub() {
  APP_PW="$APP_PW" python3 - "$1" <<'PY'
import os, sys
from urllib.parse import quote
path, pw = sys.argv[1], os.environ["APP_PW"]
text = open(path, encoding="utf-8", errors="replace").read()
for secret in {pw, quote(pw, safe="")}:
    text = text.replace(secret, "***")
open(path, "w", encoding="utf-8").write(text)
PY
}

# 3. Verify as the NEW role (both run in rolled-back transactions).
APP_ROLE_URL="$PSQL_URL" bash scripts/verify-rls.sh > ~/prod-r3-verify-rls.out 2>&1
RC=$?; scrub ~/prod-r3-verify-rls.out
(( RC == 0 )) || fail "verify-rls failed, see ~/prod-r3-verify-rls.out"
echo "2. verify-rls passed"
psql "$PSQL_URL" -X -f scripts/prod-check-runtime-role.sql > ~/prod-r3-runtime-role.out 2>&1
RC=$?; scrub ~/prod-r3-runtime-role.out
(( RC == 0 )) || fail "runtime-role check failed, see ~/prod-r3-runtime-role.out"
grep -q " $APP_ROLE " ~/prod-r3-runtime-role.out || fail "runtime-role check did not run as $APP_ROLE"
echo "3. runtime-role check ran as $APP_ROLE -> ~/prod-r3-runtime-role.out"

echo
echo "ALL CHECKS PASSED. New DATABASE_URL — paste it ONLY into Vercel → Settings →"
echo "Environment Variables → DATABASE_URL (Production, keep it Sensitive):"
echo
echo "$NEW_URL"
echo
unset DU CU APP_PW NEW_URL PSQL_URL
