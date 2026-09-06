import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Phase 2 multi-tenant context (docs/adr/0024-multi-tenant-context.md).
 *
 * A request-scoped directive that tells the Prisma tenant extension
 * (src/lib/tenant/extension.ts) which tenant the current unit of work
 * belongs to. It is set explicitly at non-session entry points — webhooks,
 * the seed script, background/system work, and tests — via `runWithTenant`
 * / `runUnscoped`. Ordinary Server Components and Server Actions do NOT set
 * it: they fall through to ambient session resolution (see resolve.ts).
 *
 * `AsyncLocalStorage` isolates the value per async call tree, so two
 * concurrent requests for different tenants can never observe each other's
 * directive — proven by tests/lib/tenant-context-concurrency.test.ts.
 */

export type TenantDirective =
  | { readonly mode: "scoped"; readonly tenantId: string; readonly source: string }
  // Deliberately opts out of tenant filtering for a narrow, audited reason
  // (login's cross-tenant email lookup, a webhook resolving its own
  // Integration row, a future platform-admin surface). Never the default.
  | { readonly mode: "unscoped"; readonly reason: string };

const storage = new AsyncLocalStorage<TenantDirective>();

/** The directive in force for the current async context, if any was set. */
export function getTenantDirective(): TenantDirective | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with every tenant-owned Prisma query scoped to `tenantId`.
 * `source` is a short free-text label for logs/debugging (e.g.
 * "webhook:woocommerce", "seed", "test").
 *
 * `fn` is `await`ed *inside* the context so that a lazy `PrismaPromise`
 * returned by `fn` (e.g. `() => prisma.x.findMany()`) still executes with
 * the directive active — the query only fires when it is awaited.
 */
export async function runWithTenant<T>(
  tenantId: string,
  source: string,
  fn: () => T | Promise<T>
): Promise<T> {
  return storage.run({ mode: "scoped", tenantId, source }, async () => fn());
}

/**
 * Run `fn` with tenant filtering DISABLED. Every use must be justified in a
 * comment — this is the escape hatch that, misused, reintroduces
 * cross-tenant access. Legitimate uses: authenticating a login before the
 * tenant is known, a webhook looking up its own Integration row.
 */
export async function runUnscoped<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
  return storage.run({ mode: "unscoped", reason }, async () => fn());
}

/**
 * The tenant id the current context is pinned to, or null when it is
 * unscoped or unset. Does NOT consult the session — callers that need the
 * fully-resolved id should use `resolveActiveTenantId` from resolve.ts.
 */
export function getDirectiveTenantId(): string | null {
  const directive = storage.getStore();
  return directive?.mode === "scoped" ? directive.tenantId : null;
}
