import { Prisma } from "@prisma/client";

/**
 * True when `error` is a Postgres unique-constraint violation (Prisma error
 * code P2002) — e.g. two concurrent requests both passing a pre-check
 * `findUnique` (SKU, slug, e-mail) before either has committed. The
 * pre-check is still worth doing for the fast, common-case friendly error;
 * this is the defense-in-depth backstop for the rare race, so a duplicate
 * submission surfaces as a normal validation error instead of an unhandled
 * 500. See docs/adr/0002-domain-model.md's audit addendum.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * True when `error` is a Postgres foreign-key-constraint violation (Prisma
 * code P2003) — e.g. deleting a row another table still references under an
 * `onDelete: Restrict` relation. Callers should pre-check the dependent
 * count for a friendly message; this is the backstop for the race where a
 * dependent row is inserted between the check and the delete.
 */
export function isForeignKeyConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

/**
 * A Postgres deadlock (40P01) that aborted the current transaction. Matches
 * ONLY the two shapes observed with this Prisma version (6.19.2) against
 * Postgres — not P2034, which is not what Prisma raises here:
 *  - a MODEL query (`tx.inventoryItem.update`, the path applyStockMovement
 *    uses): `PrismaClientUnknownRequestError`, no `code`, the Postgres code in
 *    the message (`code: "40P01"` / "deadlock detected");
 *  - a raw query: `PrismaClientKnownRequestError` P2010 with `meta.code: "40P01"`.
 * The transaction has already been rolled back when this is seen. Callers map
 * it to a "retry" message — never an automatic retry.
 */
export function isDeadlockError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /40P01|deadlock detected/i.test(error.message);
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010") {
    return (error.meta as { code?: unknown } | undefined)?.code === "40P01";
  }
  return false;
}

/**
 * An interactive transaction that expired (Prisma's default 5 s timeout),
 * e.g. while waiting on a row lock held by another operation: observed as
 * `PrismaClientKnownRequestError` P2028 ("Transaction already closed: … expired
 * transaction"). Prisma has rolled it back.
 */
export function isTransactionTimeoutError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028";
}
