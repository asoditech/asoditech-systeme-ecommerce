-- Runtime-role privileges on "whatsapp_outbox" (forward-only correction of
-- 20261016120000_delivery_payment_brand_logo_whatsapp_outbox).
--
-- Why: until now every migration relied on the migration role's
-- ALTER DEFAULT PRIVILEGES (docs/adr/0026, scripts/provision-production-role.sql)
-- to hand new tables to the runtime role. A database provisioned without
-- those defaults (found 2026-10-16 on the local test database: no
-- pg_default_acl rows) created "whatsapp_outbox" with NO privilege for
-- asoditech_app, and every query from the app failed with
-- "permission denied". 20261016120000 is already applied on that database,
-- so it is not rewritten; this follow-up grants explicitly.
--
-- Exactly what the default privileges give (SELECT, INSERT, UPDATE, DELETE —
-- no TRUNCATE, REFERENCES, TRIGGER, ownership or role attribute); the table
-- uses cuid ids, so there is no sequence to grant. Idempotent (re-granting
-- an existing privilege is a no-op) and skipped where the role does not exist
-- (e.g. a CI database without the runtime role). RLS is untouched: the table
-- keeps ENABLE + FORCE ROW LEVEL SECURITY and its "tenant_isolation" policy —
-- the grant only lets the role reach rows the policy already allows.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'asoditech_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "whatsapp_outbox" TO asoditech_app;
  END IF;
END
$$;
