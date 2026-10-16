import { describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";

/**
 * The database the tests run against, seen by the RUNTIME role
 * (DATABASE_URL = asoditech_app — docs/adr/0026): every application table is
 * reachable with exactly row-level DML, and every tenant-scoped table has
 * RLS enabled AND forced. Catches a migration that created a table without
 * granting it (whatsapp_outbox, 2026-10-16). Read-only: catalog queries only,
 * no reset, no write.
 */

const APP_TABLES_EXCLUDED = ["_prisma_migrations"];

describe("runtime role on the test database", () => {
  it("is not a superuser and cannot bypass RLS", async () => {
    const [role] = await prismaBase.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("has SELECT, INSERT, UPDATE and DELETE on every application table", async () => {
    const missing = await prismaBase.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS "table"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relname = ANY(${APP_TABLES_EXCLUDED}))
        AND NOT (has_table_privilege(current_user, c.oid, 'SELECT') AND has_table_privilege(current_user, c.oid, 'INSERT')
             AND has_table_privilege(current_user, c.oid, 'UPDATE') AND has_table_privilege(current_user, c.oid, 'DELETE'))
      ORDER BY 1`;
    expect(missing.map((r) => r.table)).toEqual([]);
  });

  it("every table with a tenantId column has RLS enabled and forced", async () => {
    const weak = await prismaBase.$queryRaw<{ table: string }[]>`
      SELECT c.relname AS "table"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM information_schema.columns col WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenantId')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY 1`;
    expect(weak.map((r) => r.table)).toEqual([]);
  });
});
