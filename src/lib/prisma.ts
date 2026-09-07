import { prismaRaw } from "@/lib/tenant/raw-client";
import { tenantExtension } from "@/lib/tenant/extension";
import { bypassExtension } from "@/lib/tenant/bypass-extension";
import { attachRlsTransaction } from "@/lib/tenant/rls";
import { resolveActiveTenant } from "@/lib/tenant/resolve";

export { prismaRaw } from "@/lib/tenant/raw-client";

/**
 * Raw-shaped client — NO app-level tenant FILTERING (every `where`/`data`
 * passes through untouched). Use only where scoping must not apply and
 * would recurse: session resolution (src/lib/auth/session.ts), the two
 * webhook routes' cross-tenant Integration lookup, the seed script, and
 * test fixtures spanning multiple tenants.
 *
 * Phase 4 (docs/adr/0026-multi-tenant-rls.md): every tenant-scoped table
 * now has Row-Level Security enabled, so "no app-level filtering" no
 * longer means "sees everything" by default — `bypassExtension` sets the
 * DB-level `app.bypass_rls` GUC on every call (and `$transaction`, via
 * `attachRlsTransaction`) so this client keeps its original, pre-RLS
 * behavior at the DB level too.
 */
export const prismaBase = attachRlsTransaction(prismaRaw.$extends(bypassExtension), async () => ({
  sql: `SELECT set_config('app.bypass_rls', 'on', true)`,
  params: [],
}));

/**
 * The application Prisma client. Every operation on a tenant-owned model is
 * automatically scoped to the active tenant by `tenantExtension`
 * (docs/adr/0024-multi-tenant-context.md). The tenant comes from an
 * explicit `runWithTenant` directive, else the logged-in user's session,
 * else the bootstrap tenant.
 *
 * Phase 4 (docs/adr/0026-multi-tenant-rls.md): the SAME resolution also
 * sets the DB-level `app.tenant_id`/`app.bypass_rls` GUC an RLS policy
 * reads, via `attachRlsTransaction` — real enforcement now lives at the
 * database, this app-level layer is defense in depth on top of it.
 */
export const prisma = attachRlsTransaction(prismaRaw.$extends(tenantExtension), async () => {
  const { tenantId, source } = await resolveActiveTenant("(transaction)", "$transaction");
  if (source === "unscoped" || tenantId === null) {
    return { sql: `SELECT set_config('app.bypass_rls', 'on', true)`, params: [] };
  }
  return { sql: `SELECT set_config('app.tenant_id', $1, true)`, params: [tenantId] };
});

/**
 * The client type handed to an interactive `prisma.$transaction(async (tx) => …)`
 * callback. Because `prisma` is `$extends`-wrapped, this is NOT
 * `Prisma.TransactionClient` — helpers that accept a transaction client must
 * use this type so the extension's tenant scoping also applies to their
 * queries.
 */
export type PrismaTransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
