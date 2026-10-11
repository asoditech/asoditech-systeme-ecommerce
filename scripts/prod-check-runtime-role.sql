-- R3 — production RUNTIME role check (docs/adr/0053; extended in Batch 1A). READ ONLY.
-- Run with the RUNTIME connection (Vercel DATABASE_URL, the app's role),
-- NOT DIRECT_URL. Strip the Prisma query string first: psql rejects
-- `?schema=public&pgbouncer=true`.
--   psql "${DATABASE_URL%%\?*}" -X -f scripts/prod-check-runtime-role.sql
--
-- Everything runs inside BEGIN READ ONLY … ROLLBACK: no statement here can
-- write, and nothing is kept. Each check prints its own *_ok / expected value.
--
-- Expected (all must hold):
--   1. runtime_role = asoditech_app (on Supabase's pooler the URL user may
--      read asoditech_app.<project-ref>; current_user is the truth);
--      rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication = f;
--      rolconfig holds no app.* setting  →  attributes_ok = t.
--   2. bypass_at_start and tenant_at_start empty  →  settings_ok = t.
--   3. no inherited role with dangerous = t (superuser / bypassrls /
--      createdb / createrole / owner of public tables).
--   4. owned_tables_directly = 0, owned_tables_incl_membership = 0,
--      owned_schemas_or_db = 0.
--   5. can_create_in_public = f, can_create_schema_in_db = f (TEMPORARY is
--      shown for information only — a temp table is session-private).
--   6. 0 rows listed; tenant_tables_rls_forced = tenant_tables_total.
--   7. every *_visible_without_tenant = 0.
--   8. auth_rate_limits and return_receptions exist and the runtime role
--      holds SELECT, INSERT, UPDATE, DELETE on both  →  all_ok = t. A
--      missing table or privilege RAISES an error and stops the script:
--      without them login/reset rate limiting silently fails open, platform
--      unlock is always refused, and the returns workspace cannot receive,
--      inspect (UPDATE / FOR UPDATE) or cancel (DELETE) a reception.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;

\echo '== 1. Runtime role attributes =='
SELECT current_user AS runtime_role,
       session_user,
       r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
       r.rolinherit, r.rolconfig,
       (NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolreplication
        AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(r.rolconfig, '{}'::text[])) AS c(setting) WHERE c.setting LIKE 'app.%'))
         AS attributes_ok
FROM pg_roles r WHERE r.rolname = current_user;

\echo '== 2. Tenant / bypass settings at connection start (expected: both empty) =='
SELECT coalesce(current_setting('app.bypass_rls', true), '') AS bypass_at_start,
       coalesce(current_setting('app.tenant_id', true), '')  AS tenant_at_start,
       (coalesce(current_setting('app.bypass_rls', true), '') = ''
        AND coalesce(current_setting('app.tenant_id', true), '') = '') AS settings_ok;

\echo '== 3. Roles current_user belongs to, directly or transitively (expected: no dangerous = t) =='
SELECT r.rolname AS member_of,
       r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
       pg_has_role(current_user, r.oid, 'USAGE') AS inherits_privileges,
       EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = r.rolname) AS owns_public_tables,
       (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole
        OR EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = r.rolname)) AS dangerous
FROM pg_roles r
WHERE r.rolname <> current_user AND pg_has_role(current_user, r.oid, 'MEMBER')
ORDER BY dangerous DESC, r.rolname;

\echo '== 4. Ownership (expected: 0, 0, 0) =='
SELECT count(*) FILTER (WHERE tableowner = current_user) AS owned_tables_directly,
       count(*) FILTER (WHERE pg_has_role(current_user, tableowner, 'MEMBER')) AS owned_tables_incl_membership
FROM pg_tables WHERE schemaname = 'public';
SELECT count(*) AS owned_schemas_or_db
FROM (SELECT nspowner AS owner FROM pg_namespace WHERE nspname = 'public'
      UNION ALL
      SELECT datdba FROM pg_database WHERE datname = current_database()) o
WHERE pg_has_role(current_user, o.owner, 'MEMBER');

\echo '== 5. CREATE privileges (expected: f, f) =='
SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_in_public,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema_in_db,
       has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temp_tables_info_only;

\echo '== 6. Tenant tables (with a tenantId column) missing RLS or FORCE RLS (expected: 0 rows) =='
SELECT c.relname, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
  AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
ORDER BY c.relname;
SELECT count(*) AS tenant_tables_total,
       count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity) AS tenant_tables_rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped);

\echo '== 7. Rows visible WITHOUT tenant context (expected: all 0) =='
SELECT (SELECT count(*) FROM orders)       AS orders_visible_without_tenant,
       (SELECT count(*) FROM users)        AS users_visible_without_tenant,
       (SELECT count(*) FROM products)     AS products_visible_without_tenant,
       (SELECT count(*) FROM audit_events) AS audit_events_visible_without_tenant;

\echo '== 8. Runtime-role privileges on the Batch 1A / P3 tables (expected: all_ok = t; a failure raises) =='
-- CASE (not AND): has_table_privilege errors on a missing table, and only
-- CASE guarantees it is never evaluated then.
SELECT table_name, table_exists, can_select, can_insert, can_update, can_delete,
       table_exists AND can_select AND can_insert AND can_update AND can_delete AS all_ok
FROM (
  SELECT t.tbl AS table_name,
         to_regclass('public.' || t.tbl) IS NOT NULL AS table_exists,
         CASE WHEN to_regclass('public.' || t.tbl) IS NULL THEN false ELSE has_table_privilege(current_user, 'public.' || t.tbl, 'SELECT') END AS can_select,
         CASE WHEN to_regclass('public.' || t.tbl) IS NULL THEN false ELSE has_table_privilege(current_user, 'public.' || t.tbl, 'INSERT') END AS can_insert,
         CASE WHEN to_regclass('public.' || t.tbl) IS NULL THEN false ELSE has_table_privilege(current_user, 'public.' || t.tbl, 'UPDATE') END AS can_update,
         CASE WHEN to_regclass('public.' || t.tbl) IS NULL THEN false ELSE has_table_privilege(current_user, 'public.' || t.tbl, 'DELETE') END AS can_delete
  FROM (VALUES ('auth_rate_limits'), ('return_receptions')) AS t(tbl)
) checks
ORDER BY table_name;
DO $$
DECLARE
  tbl text;
  priv text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['auth_rate_limits', 'return_receptions'] LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      RAISE EXCEPTION 'CHECK 8 FAILED: table public.% does not exist — apply the pending migrations first', tbl;
    END IF;
    FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege(current_user, 'public.' || tbl, priv) THEN
        RAISE EXCEPTION 'CHECK 8 FAILED: runtime role % lacks % on public.%', current_user, priv, tbl;
      END IF;
    END LOOP;
  END LOOP;
END $$;
\echo 'Check 8 passed: runtime role holds SELECT, INSERT, UPDATE, DELETE on auth_rate_limits and return_receptions.'

ROLLBACK;
