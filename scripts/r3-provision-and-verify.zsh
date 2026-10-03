#!/bin/zsh
# R3 (docs/adr/0053) — one-shot: provision the restricted runtime role in
# PRODUCTION, then verify it. Run from the repo root, in YOUR terminal:
#   zsh scripts/r3-provision-and-verify.zsh
# Asks for the current DIRECT_URL (owner, runs migrations) and the current
# DATABASE_URL (only used as a template: same host/port/query, new user +
# password). Writes nothing but the role and its grants; prints the NEW
# DATABASE_URL once, for you to paste into Vercel (Production). Results go
# to ~/prod-r3-*.out (no password in them).
set -u
setopt PIPE_FAIL

read -s "DU?Production DIRECT_URL (owner): "; echo
read -s "CU?Production DATABASE_URL (current, template): "; echo
[[ -z "$DU" || -z "$CU" ]] && { echo "Both URLs are required."; exit 1; }

APP_ROLE=asoditech_app
APP_PW=$(openssl rand -hex 32)   # hex: nothing to URL-encode

# 1. Provision (idempotent). migration_role must be the DIRECT_URL role.
MIG_ROLE=$(psql "${DU%%\?*}" -X -A -t -c "select current_user") || { echo "Cannot connect with DIRECT_URL."; exit 1; }
psql "${DU%%\?*}" -X -v app_role="$APP_ROLE" -v app_password="$APP_PW" -v migration_role="$MIG_ROLE" \
  -f scripts/provision-production-role.sql > ~/prod-r3-provision.out 2>&1
echo "1. provision exit=$? (migration_role=$MIG_ROLE) -> ~/prod-r3-provision.out"

# 2. New DATABASE_URL: same host/port/db/query as the current one, user/password swapped.
#    Supabase pooler user format "<role>.<project_ref>" is preserved.
NEW_URL=$(CU="$CU" APP_ROLE="$APP_ROLE" APP_PW="$APP_PW" python3 - <<'PY'
import os
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(os.environ["CU"]); user = u.username or ""
ref = "." + user.split(".", 1)[1] if "." in user else ""
netloc = f'{os.environ["APP_ROLE"]}{ref}:{os.environ["APP_PW"]}@{u.hostname}' + (f":{u.port}" if u.port else "")
print(urlunsplit((u.scheme, netloc, u.path, u.query, u.fragment)))
PY
) || { echo "Could not build the new URL."; exit 1; }

# 3. Verify as the NEW role (both run in rolled-back transactions).
APP_ROLE_URL="${NEW_URL%%\?*}" bash scripts/verify-rls.sh > ~/prod-r3-verify-rls.out 2>&1
echo "2. verify-rls exit=$? -> ~/prod-r3-verify-rls.out"
psql "${NEW_URL%%\?*}" -X -f scripts/prod-check-runtime-role.sql > ~/prod-r3-runtime-role.out 2>&1
echo "3. runtime-role check exit=$? -> ~/prod-r3-runtime-role.out"

echo
echo "NEW DATABASE_URL — paste into Vercel → Settings → Environment Variables →"
echo "DATABASE_URL (Production only, keep it Sensitive). Do NOT paste it in chat:"
echo
echo "$NEW_URL"
echo
unset DU CU APP_PW NEW_URL
