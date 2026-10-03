-- R3 — production RUNTIME role check (docs/adr/0053). READ ONLY.
-- Run with the RUNTIME connection (Vercel DATABASE_URL, the app's role),
-- NOT DIRECT_URL. Strip the Prisma query string first: psql rejects
-- `?schema=public&pgbouncer=true`.
--   psql "${DATABASE_URL%%\?*}" -X -f scripts/prod-check-runtime-role.sql
-- Expected: rolsuper = f, rolbypassrls = f, owns_orders = f, orders_visible = 0.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SELECT current_user AS runtime_role, r.rolsuper, r.rolbypassrls,
       (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'orders') = current_user AS owns_orders
FROM pg_roles r WHERE r.rolname = current_user;
-- No tenant GUC set: Row-Level Security must hide every row.
SELECT count(*) AS orders_visible_without_tenant_context FROM orders;
SELECT relname, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class WHERE relname IN ('orders','users','products','audit_events') ORDER BY relname;
ROLLBACK;
