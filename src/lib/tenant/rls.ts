import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { prismaRaw } from "@/lib/tenant/raw-client";

/** The array-form `$transaction` overload requires a branded
 * `PrismaPromise<any>[]` — the queries batched here really are that at
 * runtime (a Client Extension's forwarded `query(args)` is a genuine
 * PrismaPromise, verified directly against Postgres), TS just can't see
 * it through this file's generic types. One local cast, used at both call
 * sites below, rather than sprinkling `as any`. */
type PrismaPromiseBatch = Prisma.PrismaPromise<unknown>[];

/**
 * Phase 4 (docs/adr/0026-multi-tenant-rls.md) — DB-level enforcement via
 * Postgres Row-Level Security, layered UNDER the Phase 2/3 app-level
 * extension (src/lib/tenant/extension.ts), not instead of it.
 *
 * Every tenant-scoped table has an RLS policy of the shape:
 *
 *   USING (current_setting('app.bypass_rls', true) = 'on'
 *          OR "tenantId" = current_setting('app.tenant_id', true))
 *
 * `current_setting(name, true)` returns NULL when the GUC was never set in
 * this session — NULL never equals anything, so a connection that never
 * ran one of the helpers below sees ZERO rows on every tenant-scoped
 * table. Default-deny, not default-allow.
 *
 * The GUCs are set via `SET LOCAL` (through `set_config(..., true)`),
 * which is scoped to the CURRENT TRANSACTION and reverts automatically at
 * COMMIT/ROLLBACK. This is deliberate and required: this app's
 * DATABASE_URL is the pooled (PgBouncer) connection, and in transaction-
 * pooling mode a "session"-scoped `SET` would leak onto whichever
 * unrelated request/tenant happens to reuse that backend connection next.
 * `SET LOCAL` inside an explicit transaction is safe under any pooling
 * mode.
 *
 * For that to actually protect anything, the GUC must be the FIRST
 * statement of every Postgres transaction the app opens — a single
 * top-level Prisma call is itself an implicit one-statement transaction,
 * and a `SET LOCAL` sent as a separate round-trip before it would have
 * already reverted (it "belongs" to its own, already-committed implicit
 * transaction). Two mechanisms below make that true for every call:
 *
 *  - `wrapOperationWithTenant`/`wrapOperationWithBypass` — for a bare
 *    top-level call (`prisma.order.findMany()`), batches the SET with the
 *    forwarded query into one real transaction via `prismaRaw.$transaction
 *    ([setConfig, query(args)])`. Verified at the Prisma-internals level:
 *    a Client Extension's forwarded `query(args)` is a lazy, unexecuted
 *    PrismaPromise, exactly what the batch-array form of `$transaction`
 *    expects — it is NOT a plain already-dispatched Promise.
 *  - `attachRlsTransaction` — overrides `$transaction` itself (plain
 *    property reassignment; Prisma Client Extensions cannot override core
 *    client methods) so `prisma.$transaction(async (tx) => {...})` sets
 *    the GUC once, before the caller's callback runs, on the interactive
 *    transaction's own connection. `isInsideRlsTransaction()` then tells
 *    every NESTED `tx.model.op()` call inside that callback to skip
 *    wrapping itself — the GUC already applies to the whole transaction,
 *    including any raw `tx.$queryRaw`/`tx.$executeRaw` (advisory locks,
 *    `FOR UPDATE`, `ensureInventoryItem`'s raw INSERT, …) issued within it.
 *
 * Only the interactive-callback form of `$transaction` is supported —
 * verified nothing in this codebase uses the batch-array form on the
 * extended clients (`prismaBase.$transaction([...])` in
 * tests/helpers/db.ts uses the callback form; see git history).
 */

const insideRlsTransaction = new AsyncLocalStorage<true>();

/** True while executing inside a transaction opened by `attachRlsTransaction` — the RLS GUC for this whole transaction was already set once, at its start. */
export function isInsideRlsTransaction(): boolean {
  return insideRlsTransaction.getStore() === true;
}

function runInsideRlsTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
  return insideRlsTransaction.run(true, async () => fn());
}

async function runRlsBatch<T>(sql: string, params: unknown[], query: (args: unknown) => Promise<T>, args: unknown): Promise<T> {
  if (isInsideRlsTransaction()) {
    return query(args);
  }
  const [, result] = await prismaRaw.$transaction([
    prismaRaw.$executeRawUnsafe(sql, ...params),
    query(args),
  ] as unknown as PrismaPromiseBatch);
  return result as T;
}

/** Wraps a single top-level tenant-scoped operation so the RLS policy sees `app.tenant_id`. */
export function wrapOperationWithTenant<T>(tenantId: string, query: (args: unknown) => Promise<T>, args: unknown): Promise<T> {
  return runRlsBatch(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId], query, args);
}

/** Wraps a single top-level operation so the RLS policy sees the `app.bypass_rls` escape hatch (unscoped directives, and every `prismaBase` call). */
export function wrapOperationWithBypass<T>(query: (args: unknown) => Promise<T>, args: unknown): Promise<T> {
  return runRlsBatch(`SELECT set_config('app.bypass_rls', 'on', true)`, [], query, args);
}

/**
 * For the handful of raw-SQL call sites that build their own
 * `$queryRaw`/`$executeRaw` PrismaPromises directly (they can't go through
 * `$allOperations` — raw queries aren't model operations) and need more
 * than one statement to share a transaction with a `SET LOCAL` prefix.
 * `queries` can be built via `prisma.$queryRaw`/`prismaRaw.$queryRaw`
 * interchangeably — raw queries bypass every extension either way, so
 * both point at the exact same unwrapped call.
 */
export async function runRawBatchWithTenant(tenantId: string, queries: readonly unknown[]): Promise<unknown[]> {
  const results = await prismaRaw.$transaction([
    prismaRaw.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId),
    ...queries,
  ] as unknown as PrismaPromiseBatch);
  return results.slice(1);
}

interface RlsSetStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Minimal shape `attachRlsTransaction` needs — matches both `prisma` and
 * `prismaBase`. `any[]` (not `unknown[]`) deliberately: this only needs to
 * structurally accept the real, overloaded `$transaction` signature for
 * the mutation below, not describe it — a stricter parameter type makes
 * TS reject the real client as "not assignable" before inference even
 * gets a chance to preserve its full type in the `C` type parameter. */
interface TransactionCapable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: (...args: any[]) => Promise<unknown>;
}

/**
 * Replaces `client.$transaction` with a version that issues `resolveSetStatement()`'s
 * SET LOCAL as the first statement of the transaction, before the caller's
 * callback runs, and marks the callback's execution so nested operations
 * don't re-wrap themselves. Only the interactive-callback form is
 * supported — the batch-array form throws (nothing in this codebase uses
 * it on an extended client; the caller can use `prismaRaw` directly for
 * pure batch work with no tenant context of its own).
 */
export function attachRlsTransaction<C extends TransactionCapable>(client: C, resolveSetStatement: () => Promise<RlsSetStatement>): C {
  const original = client.$transaction.bind(client);
  (client as unknown as TransactionCapable).$transaction = async (arg: unknown, options?: unknown) => {
    if (Array.isArray(arg)) {
      throw new Error(
        "[tenant] $transaction([...]) (batch-array form) is not supported on this client — RLS needs a " +
          "callback so SET LOCAL can run first. Use $transaction(async (tx) => { ... }) instead."
      );
    }
    const { sql, params } = await resolveSetStatement();
    return original(async (tx: unknown) => {
      await (tx as { $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number> }).$executeRawUnsafe(sql, ...params);
      return runInsideRlsTransaction(() => (arg as (tx: unknown) => Promise<unknown>)(tx));
    }, options);
  };
  return client;
}
