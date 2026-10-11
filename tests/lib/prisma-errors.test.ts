import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isDeadlockError, isTransactionTimeoutError, isUniqueConstraintError } from "@/lib/prisma-errors";
import { resetDb } from "../helpers/db";

/**
 * P2 — the error shapes the confirmation maps to « réessayez », verified
 * against the real test database (Prisma 6.19.2 + Postgres, READ COMMITTED).
 * Every transaction here rolls back.
 */

const ROLLBACK = new Error("ROLLBACK");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function twoRows() {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const a = await prisma.product.create({ data: { name: "A", sku: "PE-A", price: 1, status: "ACTIF" } });
  const b = await prisma.product.create({ data: { name: "B", sku: "PE-B", price: 1, status: "ACTIF" } });
  const ia = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: a.id, quantityOnHand: 5 } });
  const ib = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: b.id, quantityOnHand: 5 } });
  return [ia.id, ib.id] as const;
}

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("isDeadlockError / isTransactionTimeoutError", () => {
  it("a real deadlock through MODEL updates (the applyStockMovement path) is recognised", async () => {
    const [x, y] = await twoRows();
    const lockBoth = (first: string, second: string) =>
      prisma.$transaction(
        async (tx) => {
          await tx.inventoryItem.update({ where: { id: first }, data: { quantityReserved: { increment: 1 } } });
          await sleep(300);
          await tx.inventoryItem.update({ where: { id: second }, data: { quantityReserved: { increment: 1 } } });
          throw ROLLBACK;
        },
        { timeout: 15_000 }
      );
    const results = await Promise.allSettled([lockBoth(x, y), lockBoth(y, x)]);
    const errors = results.map((r) => (r.status === "rejected" ? r.reason : null));
    const deadlocks = errors.filter((e) => e !== ROLLBACK && isDeadlockError(e));
    expect(deadlocks).toHaveLength(1);
    expect(deadlocks[0]).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(errors.filter((e) => e === ROLLBACK)).toHaveLength(1);
    // both rolled back
    const rows = await prisma.inventoryItem.findMany({ where: { id: { in: [x, y] } } });
    expect(rows.every((r) => r.quantityReserved === 0)).toBe(true);
  }, 30_000);

  it("the raw-query deadlock shape (P2010 + meta.code 40P01) is recognised", () => {
    const raw = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `40P01`. Message: `deadlock detected`", {
      code: "P2010",
      clientVersion: "6.19.2",
      meta: { code: "40P01", message: "deadlock detected" },
    });
    expect(isDeadlockError(raw)).toBe(true);
    const otherRaw = new Prisma.PrismaClientKnownRequestError("Raw query failed.", { code: "P2010", clientVersion: "6.19.2", meta: { code: "23505" } });
    expect(isDeadlockError(otherRaw)).toBe(false);
  });

  it("a real expired interactive transaction (lock wait beyond the default timeout) is P2028", async () => {
    const [x] = await twoRows();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.inventoryItem.update({ where: { id: x }, data: { quantityReserved: { increment: 1 } } });
        await Promise.race([held, sleep(7_000)]);
        throw ROLLBACK;
      },
      { timeout: 20_000 }
    );
    await sleep(200);
    const waiter = prisma.$transaction(async (tx) => {
      await tx.inventoryItem.update({ where: { id: x }, data: { quantityReserved: { increment: 1 } } });
    }); // default timeout (5 s)
    const [h, w] = await Promise.allSettled([holder, waiter]);
    release();
    expect(h.status === "rejected" && h.reason).toBe(ROLLBACK);
    expect(w.status).toBe("rejected");
    if (w.status === "rejected") {
      expect(isTransactionTimeoutError(w.reason)).toBe(true);
      expect(isDeadlockError(w.reason)).toBe(false);
    }
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: x } })).quantityReserved).toBe(0);
  }, 30_000);

  it("ordinary errors are neither", () => {
    expect(isDeadlockError(new Error("deadlock detected"))).toBe(false); // not a Prisma error
    expect(isTransactionTimeoutError(new Error("P2028"))).toBe(false);
    const unique = new Prisma.PrismaClientKnownRequestError("Unique", { code: "P2002", clientVersion: "6.19.2" });
    expect(isDeadlockError(unique)).toBe(false);
    expect(isTransactionTimeoutError(unique)).toBe(false);
    expect(isUniqueConstraintError(unique)).toBe(true);
  });
});
