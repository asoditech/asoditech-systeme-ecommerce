import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findDuplicateCustomerGroups, type AuditCustomer } from "@/lib/customers/duplicate-audit";

/** The read-only duplicate audit (customer-identity plan §4): same rule as findOrCreateCustomer, per company. */
const at = (n: number) => new Date(Date.UTC(2026, 0, n));
const c = (id: string, tenantId: string, fullName: string, phone: string | null, day: number): AuditCustomer => ({ id, tenantId, fullName, phone, createdAt: at(day) });

describe("findDuplicateCustomerGroups", () => {
  it("groups same normalized name + phone within one company, oldest first; other names, other phones and other companies are not duplicates", () => {
    const result = findDuplicateCustomerGroups([
      c("b", "t1", "  Fatima   Zahra ", "06 12 34 56 78", 2),
      c("a", "t1", "fatima zahra", "+212612345678", 1),
      c("c", "t1", "FATIMA ZAHRA", "0612345678", 3),
      c("d", "t1", "Fatima Z.", "0612345678", 4), // other name
      c("e", "t1", "Fatima Zahra", "0612345679", 5), // other phone
      c("f", "t2", "Fatima Zahra", "0612345678", 6), // other company
      c("g", "t2", "Fatima Zahra", "0612345678", 7),
      c("h", "t1", "Sans téléphone", null, 8),
      c("i", "t1", "Sans téléphone", "", 9),
    ]);
    expect(result.groups).toEqual([
      { tenantId: "t1", customerIds: ["a", "b", "c"] },
      { tenantId: "t2", customerIds: ["f", "g"] },
    ]);
    expect(result).toMatchObject({ scanned: 9, unmatchable: 2, surplusRows: 3, byTenant: { t1: { groups: 1, surplusRows: 2 }, t2: { groups: 1, surplusRows: 1 } } });
  });

  it("no duplicates → no groups", () => {
    expect(findDuplicateCustomerGroups([c("a", "t1", "A", "0611111111", 1), c("b", "t1", "B", "0611111111", 2)])).toMatchObject({ groups: [], surplusRows: 0 });
  });

  it("the script is read-only and refuses an unnamed target", () => {
    const script = readFileSync(join(process.cwd(), "scripts/audit-customer-duplicates.ts"), "utf8");
    expect(script).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$queryRaw/);
    // the only raw statements: the read-only transaction and the documented RLS read escape hatch
    expect([...script.matchAll(/\$executeRawUnsafe\(("[^"]*")\)/g)].map((m) => m[1])).toEqual([
      '"SET TRANSACTION READ ONLY"',
      `"SELECT set_config('app.bypass_rls', 'on', true)"`,
    ]);
    expect(script).toContain("--target-host=");
    expect(script).toContain("target !== host");
  });
});
