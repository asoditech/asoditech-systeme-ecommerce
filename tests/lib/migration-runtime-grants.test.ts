import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Runtime-role privileges in migrations (2026-10-16). New tables used to
 * rely only on the migration role's ALTER DEFAULT PRIVILEGES (docs/adr/0026);
 * a database provisioned without them created `whatsapp_outbox` with no
 * privilege for asoditech_app. From 20261016130000 on, a migration that
 * creates a table also grants it explicitly (conditional on the role), and
 * never weakens RLS. Static check of the SQL — no database.
 */

const DIR = path.resolve(import.meta.dirname, "../../prisma/migrations");
const CONVENTION_FROM = "20261016130000";
const migrations = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, sql: readFileSync(path.join(DIR, d.name, "migration.sql"), "utf8") }));
const codeOf = (sql: string) => sql.replace(/--.*$/gm, "");
const createdTables = (sql: string) => [...codeOf(sql).matchAll(/CREATE TABLE\s+"([^"]+)"/g)].map((m) => m[1]);
const grantsRuntime = (sql: string, table: string) =>
  new RegExp(`GRANT\\s+SELECT,\\s*INSERT,\\s*UPDATE,\\s*DELETE\\s+ON\\s+TABLE\\s+"${table}"\\s+TO\\s+asoditech_app`).test(codeOf(sql));

describe("runtime-role privileges in migrations", () => {
  it("whatsapp_outbox (created by 20261016120000) is granted by the forward-only follow-up, conditional on the role", () => {
    const fix = migrations.find((m) => m.name === "20261016130000_whatsapp_outbox_runtime_grant");
    expect(fix).toBeDefined();
    expect(grantsRuntime(fix!.sql, "whatsapp_outbox")).toBe(true);
    expect(codeOf(fix!.sql)).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'asoditech_app'\)/);
    // The original migration is not rewritten (it is applied on the local test database).
    const original = migrations.find((m) => m.name === "20261016120000_delivery_payment_brand_logo_whatsapp_outbox");
    expect(original && grantsRuntime(original.sql, "whatsapp_outbox")).toBe(false);
  });

  it(`every table created from ${CONVENTION_FROM} on is granted to the runtime role in the same migration`, () => {
    const missing = migrations
      .filter((m) => m.name >= CONVENTION_FROM)
      .flatMap((m) => createdTables(m.sql).filter((t) => !grantsRuntime(m.sql, t)).map((t) => `${m.name}: ${t}`));
    expect(missing).toEqual([]);
  });

  it("the recent migrations never weaken RLS nor grant more than row access", () => {
    const forbidden = [/DISABLE ROW LEVEL SECURITY/i, /NO FORCE ROW LEVEL SECURITY/i, /BYPASSRLS/i, /SUPERUSER/i, /GRANT\s+ALL/i, /TRUNCATE/i, /DROP POLICY/i];
    const offenders = migrations
      .filter((m) => m.name >= "20261015120000")
      .flatMap((m) => forbidden.filter((re) => re.test(codeOf(m.sql))).map((re) => `${m.name}: ${re}`));
    expect(offenders).toEqual([]);
  });

  it("whatsapp_outbox keeps RLS enabled + forced with the tenant_isolation policy", () => {
    const sql = codeOf(migrations.find((m) => m.name === "20261016120000_delivery_payment_brand_logo_whatsapp_outbox")!.sql);
    expect(sql).toMatch(/ALTER TABLE "whatsapp_outbox" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "whatsapp_outbox" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/CREATE POLICY "tenant_isolation" ON "whatsapp_outbox"/);
  });
});
