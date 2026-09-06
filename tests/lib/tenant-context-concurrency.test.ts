import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { getDirectiveTenantId, runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";

// Proves the AsyncLocalStorage tenant context cannot leak between
// concurrently-running units of work (docs/adr/0024). Tenant A holds a
// different number of rows than tenant B, and many interleaved tasks — each
// pinned to one tenant, each awaiting at random points — must every time
// see only their own tenant's data.

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = "tenant-b";
const A_ROWS = 3;
const B_ROWS = 7;

async function seed() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: "tenant-b" } });
  for (let i = 0; i < A_ROWS; i++) {
    await prismaBase.customer.create({ data: { fullName: `A-${i}`, tenantId: TENANT_A } });
  }
  for (let i = 0; i < B_ROWS; i++) {
    await prismaBase.customer.create({ data: { fullName: `B-${i}`, tenantId: TENANT_B } });
  }
}

describe("tenant context — concurrency safety", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("40 interleaved tasks each see only their own tenant", async () => {
    await seed();

    const tasks = Array.from({ length: 40 }, (_, i) => {
      const tenantId = i % 2 === 0 ? TENANT_A : TENANT_B;
      const expected = i % 2 === 0 ? A_ROWS : B_ROWS;
      const prefix = i % 2 === 0 ? "A-" : "B-";
      return runWithTenant(tenantId, `task-${i}`, async () => {
        await sleep(Math.random() * 15);
        const seenId = getDirectiveTenantId();
        const count = await prisma.customer.count();
        await sleep(Math.random() * 15);
        const rows = await prisma.customer.findMany();
        return {
          ok:
            seenId === tenantId &&
            count === expected &&
            rows.length === expected &&
            rows.every((r) => r.fullName.startsWith(prefix)),
        };
      });
    });

    const results = await Promise.all(tasks);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("nested runWithTenant — the inner tenant wins, the outer is restored after", async () => {
    await seed();

    const [inner, outerAfter] = await runWithTenant(TENANT_A, "outer", async () => {
      const innerCount = await runWithTenant(TENANT_B, "inner", async () => {
        await sleep(5);
        return prisma.customer.count();
      });
      const outerCount = await prisma.customer.count();
      return [innerCount, outerCount];
    });

    expect(inner).toBe(B_ROWS);
    expect(outerAfter).toBe(A_ROWS);
  });

  it("runUnscoped nested inside runWithTenant lifts scoping only for its callback", async () => {
    await seed();

    const { scoped, unscoped, scopedAgain } = await runWithTenant(TENANT_A, "outer", async () => {
      const scoped = await prisma.customer.count();
      const unscoped = await runUnscoped("peek", () => prisma.customer.count());
      const scopedAgain = await prisma.customer.count();
      return { scoped, unscoped, scopedAgain };
    });

    expect(scoped).toBe(A_ROWS);
    expect(unscoped).toBe(A_ROWS + B_ROWS);
    expect(scopedAgain).toBe(A_ROWS);
  });

  it("a rejected task never corrupts a concurrent task's context", async () => {
    await seed();

    const good = runWithTenant(TENANT_B, "good", async () => {
      await sleep(10);
      return prisma.customer.count();
    });
    const bad = runWithTenant(TENANT_A, "bad", async () => {
      await sleep(2);
      throw new Error("boom");
    });

    await expect(bad).rejects.toThrow("boom");
    expect(await good).toBe(B_ROWS);
  });
});
