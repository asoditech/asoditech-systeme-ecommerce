-- Provisions the restricted Postgres role the app's DATABASE_URL must use
-- in every environment (docs/adr/0026-multi-tenant-rls.md §2). Without
-- this, RLS enforces nothing: a superuser or the tables' owner bypasses
-- it unconditionally, and this app's runtime connection must be neither.
--
-- This step has no equivalent in prisma/migrations/ on purpose — it needs
-- a password, which does not belong in migration history, and role
-- provisioning is infrastructure Prisma migrations have no portable way
-- to express across providers anyway.
--
-- USAGE
--   Run this ONCE per environment (local dev, test, staging, production),
--   AFTER `prisma migrate deploy` has created the tables (the GRANT
--   statements below need the tables to already exist; the ALTER DEFAULT
--   PRIVILEGES statement covers every table created by a LATER migration
--   automatically, so this does not need to be re-run after that first
--   time — see the note at the bottom for the one case where it does).
--
--   Connect as the DATABASE OWNER/admin role (the same role DIRECT_URL
--   uses to run migrations — e.g. `postgres` on Supabase, the role Neon
--   creates for your project database, etc.), then:
--
--     psql "<owner connection string>" \
--       -v app_role=asoditech_app \
--       -v app_password="REPLACE_WITH_A_STRONG_RANDOM_PASSWORD" \
--       -v migration_role=postgres \
--       -f scripts/provision-production-role.sql
--
--   No quotes inside the -v value: :'app_password' below already quotes it,
--   so "'secret'" would make the quotes part of the password. A hex
--   password (`openssl rand -hex 32`) also needs no URL-encoding later.
--   scripts/r3-provision-and-verify.zsh does all of this in one step.
--
--   Adjust -v migration_role to whatever role actually ran (or will run)
--   `prisma migrate deploy` in this environment — check with
--   `SELECT current_user;` while connected via DIRECT_URL. Getting this
--   wrong doesn't error; it just means ALTER DEFAULT PRIVILEGES silently
--   applies to the wrong role and future tables get no grants.
--
-- AFTER RUNNING
--   Point this environment's DATABASE_URL at :app_role (with its real
--   password), and verify with scripts/verify-rls.sh before treating the
--   environment as production-ready.

\set ON_ERROR_STOP on

-- Idempotent: skip creation if the role already exists (e.g. re-running
-- this script after a later migration added tables — see the bottom
-- note), but always re-assert its attributes and password in case either
-- drifted. Built as a conditional \gexec rather than a DO $$ ... $$
-- block: psql does NOT interpolate :variables inside dollar-quoted
-- bodies (verified directly — it's a real, easy trap), so a DO block
-- here would silently send the literal text ":'app_role'" to the server
-- instead of its value.
SELECT 'CREATE ROLE ' || quote_ident(:'app_role') || ' WITH LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role')
\gexec

-- SUPERUSER / REPLICATION can only be changed by a superuser. On managed
-- Postgres (Supabase: `postgres` is NOT a superuser) naming them at all is
-- refused, so they are only re-asserted when the operator IS a superuser;
-- otherwise the role keeps the defaults a non-superuser creates it with
-- (NOSUPERUSER, NOREPLICATION). The sanity check at the bottom proves it.
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L NOBYPASSRLS NOCREATEDB NOCREATEROLE%s',
              :'app_role', :'app_password',
              CASE WHEN (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
                   THEN ' NOSUPERUSER NOREPLICATION' ELSE '' END)
\gexec

GRANT USAGE ON SCHEMA public TO :app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :app_role;

-- Covers every table/sequence a FUTURE migration creates, as long as that
-- migration keeps running as :migration_role. If the role that runs
-- `prisma migrate deploy` ever changes, re-run this whole script with the
-- new -v migration_role — the ALTER DEFAULT PRIVILEGES below is scoped to
-- one specific role and does not follow a rename or role swap.
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :app_role;
ALTER DEFAULT PRIVILEGES FOR ROLE :migration_role IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :app_role;

-- Sanity check, printed for the operator to eyeball — :app_role must show
-- rolsuper=f and rolbypassrls=f, or RLS is inert for it regardless of the
-- policies themselves.
SELECT rolname, rolsuper AS is_superuser, rolbypassrls AS bypasses_rls
FROM pg_roles WHERE rolname = :'app_role';
-- Hard stop if the role could still bypass RLS (ON_ERROR_STOP aborts the run).
-- (A row-dependent failing cast, not a constant like 1/0: the planner would
-- fold a constant and raise even when this branch is never taken.)
SELECT CASE WHEN rolsuper OR rolbypassrls
            THEN ('UNSAFE ROLE ' || rolname || ' CAN BYPASS RLS')::int::text
            ELSE 'OK: ' || rolname || ' cannot bypass RLS' END AS rls_role_check
FROM pg_roles WHERE rolname = :'app_role';
