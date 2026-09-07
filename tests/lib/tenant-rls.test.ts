import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, prismaBase, prismaRaw } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";

// Phase 4 (docs/adr/0026-multi-tenant-rls.md) — proves enforcement lives at
// the DATABASE, not just the app-level Prisma extension (tests/lib/
// tenant-isolation.test.ts already covers that layer exhaustively). Every
// test here talks to Postgres via `prismaRaw` — the genuinely unextended
// client, with NO app-level `where`/`data` scoping, NO `TenantIsolationError`,
// NOTHING but a raw SQL statement and whatever session GUC this test sets by
// hand. If a query here is still blocked, it's the database doing it, not
// this app's code — exactly what an app-level bug, a raw-SQL call site, a
// nested Prisma write, or a future regression would still need to get past.

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = "tenant-b-rls";

async function seedBothTenants() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
  const custA = await prismaBase.customer.create({ data: { fullName: "A customer", tenantId: TENANT_A } });
  const custB = await prismaBase.customer.create({ data: { fullName: "B customer", tenantId: TENANT_B } });
  const orderA = await prismaBase.order.create({
    data: { customerId: custA.id, subtotal: 10, total: 10, currency: "MAD", tenantId: TENANT_A },
  });
  const orderB = await prismaBase.order.create({
    data: { customerId: custB.id, subtotal: 20, total: 20, currency: "MAD", tenantId: TENANT_B },
  });
  return { custA, custB, orderA, orderB };
}

/** Sets the RLS GUCs directly on `prismaRaw`'s connection for one statement
 * (via the batch-array `$transaction`, which — unlike `prisma`/`prismaBase`
 * — `prismaRaw` still supports, since it carries no extension at all). */
async function asTenant<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prismaRaw.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId);
    return fn(tx);
  });
}

async function withNoTenantSet<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prismaRaw.$transaction(async (tx) => fn(tx));
}

describe("Phase 4 — RLS enforced at the database, independent of the app extension", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("a connection with NO tenant GUC set sees zero rows on a tenant-scoped table, even though rows exist", async () => {
    await seedBothTenants();
    const rows = await withNoTenantSet((tx) => tx.customer.findMany());
    expect(rows).toEqual([]);
  });

  it("raw SELECT scoped to tenant A never returns tenant B's rows, with no app-level where clause at all", async () => {
    await seedBothTenants();
    const asA = await asTenant(TENANT_A, (tx) => tx.customer.findMany());
    expect(asA.map((c) => c.fullName)).toEqual(["A customer"]);
    const asB = await asTenant(TENANT_B, (tx) => tx.customer.findMany());
    expect(asB.map((c) => c.fullName)).toEqual(["B customer"]);
  });

  it("a raw INSERT smuggling a foreign tenantId is rejected by WITH CHECK, not merely by app code", async () => {
    await seedBothTenants();
    await expect(
      asTenant(TENANT_A, (tx) =>
        tx.$executeRaw`INSERT INTO customers (id, "tenantId", "fullName", country, tags, "isBlacklisted", source, "createdAt", "updatedAt")
          VALUES ('smuggled-1', ${TENANT_B}, 'Smuggled', 'Maroc', '{}', false, 'INTERNE', now(), now())`
      )
    ).rejects.toThrow(/row-level security/i);
    const found = await prismaBase.customer.findUnique({ where: { id: "smuggled-1" } });
    expect(found).toBeNull();
  });

  it("a raw UPDATE scoped to tenant A cannot touch tenant B's row by id — zero rows affected, not an error", async () => {
    const { orderB } = await seedBothTenants();
    const affected = await asTenant(
      TENANT_A,
      (tx) => tx.$executeRaw`UPDATE orders SET notes = 'tampered' WHERE id = ${orderB.id}`
    );
    expect(affected).toBe(0);
    const fresh = await prismaBase.order.findUnique({ where: { id: orderB.id } });
    expect(fresh?.notes).toBeNull();
  });

  it("a raw DELETE scoped to tenant A cannot remove tenant B's row by id", async () => {
    const { orderB } = await seedBothTenants();
    const affected = await asTenant(TENANT_A, (tx) => tx.$executeRaw`DELETE FROM orders WHERE id = ${orderB.id}`);
    expect(affected).toBe(0);
    expect(await prismaBase.order.findUnique({ where: { id: orderB.id } })).not.toBeNull();
  });

  it("SELECT ... FOR UPDATE scoped to tenant A cannot even see (let alone lock) tenant B's row", async () => {
    const { orderB } = await seedBothTenants();
    const rows = await asTenant(
      TENANT_A,
      (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${orderB.id} FOR UPDATE`
    );
    expect(rows).toEqual([]);
  });

  it("pg_advisory_xact_lock itself is never RLS-gated (it's not a table), but the row it guards still is", async () => {
    const { orderB } = await seedBothTenants();
    // The lock call always succeeds (advisory locks aren't rows in a
    // table), but a subsequent tenant-A-scoped read of the row it was
    // meant to guard still correctly sees nothing.
    const result = await asTenant(TENANT_A, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order:${orderB.id}`}))`;
      return tx.order.findUnique({ where: { id: orderB.id } });
    });
    expect(result).toBeNull();
  });

  it("the bypass GUC (used by prismaBase, login, webhook resolution) genuinely sees every tenant", async () => {
    await seedBothTenants();
    const rows = await prismaRaw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
      return tx.customer.findMany();
    });
    expect(rows.map((c) => c.fullName).sort()).toEqual(["A customer", "B customer"]);
  });

  it("prismaBase (the app's own raw client) still sees every tenant now that RLS is on — the bypass wiring works end to end", async () => {
    await seedBothTenants();
    const rows = await prismaBase.customer.findMany();
    expect(rows.map((c) => c.fullName).sort()).toEqual(["A customer", "B customer"]);
  });
});

describe("Phase 4 — nested-write tenant stamping (extension.ts's stampNestedWrites)", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("a nested order.create({ data: { items: { create: [...] } } }) stamps the CORRECT tenant on the nested rows, not the column default", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const customer = await runWithTenant(TENANT_B, "test", () => prisma.customer.create({ data: { fullName: "B" } }));

    const order = await runWithTenant(TENANT_B, "test", () =>
      prisma.order.create({
        data: {
          customerId: customer.id,
          subtotal: 100,
          total: 100,
          currency: "MAD",
          items: {
            create: [
              { nameSnapshot: "Widget", skuSnapshot: "W-1", unitPrice: 100, quantity: 1, total: 100 },
            ],
          },
        },
        include: { items: true },
      })
    );

    expect(order.tenantId).toBe(TENANT_B);
    expect(order.items).toHaveLength(1);
    // Before Phase 4 this silently landed in the column default ("default")
    // regardless of the active tenant — the exact bypass this fix closes.
    expect(order.items[0].tenantId).toBe(TENANT_B);

    // And RLS itself confirms it: tenant A can't see the nested item either.
    const asA = await asTenant(TENANT_A, (tx) => tx.orderItem.findMany({ where: { orderId: order.id } }));
    expect(asA).toEqual([]);
    const asB = await asTenant(TENANT_B, (tx) => tx.orderItem.findMany({ where: { orderId: order.id } }));
    expect(asB).toHaveLength(1);
  });

  it("a smuggled foreign tenantId inside a nested create is rejected, same as the top level", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const customer = await runWithTenant(TENANT_A, "test", () => prisma.customer.create({ data: { fullName: "A" } }));

    await expect(
      runWithTenant(TENANT_A, "test", () =>
        prisma.order.create({
          data: {
            customerId: customer.id,
            subtotal: 1,
            total: 1,
            currency: "MAD",
            items: {
              create: [{ nameSnapshot: "x", skuSnapshot: "x", unitPrice: 1, quantity: 1, total: 1, tenantId: TENANT_B }],
            },
          },
        })
      )
    ).rejects.toThrow();
  });
});
