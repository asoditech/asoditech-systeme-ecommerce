import "server-only";

import { getTenantDirective } from "@/lib/tenant/context";
import { SESSION_COOKIE } from "@/lib/auth/session";

/**
 * The single bootstrap tenant every existing row was backfilled to in
 * Phase 1 (docs/adr/0023). Until real provisioning exists it is also the
 * fallback tenant — see `resolveActiveTenant`.
 */
export const BOOTSTRAP_TENANT_ID = "default";

// A session token identifies exactly one user, and a user's tenant never
// changes, so `token → tenantId` is safe to memoise process-wide. This is
// only a scoping accelerator — the real auth check still runs per request
// in the route guards via getCurrentUser(). Cleared wholesale if it grows
// unreasonably (new deploy resets it anyway).
const tenantByToken = new Map<string, string>();

async function readSessionToken(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  } catch {
    // cookies() throws outside a request scope (background work, seed, most
    // unit tests) — those paths use an explicit directive or the fallback.
    return null;
  }
}

/**
 * Ambient tenant for the current request, derived from the logged-in user.
 * Returns null when there is no session. Imported lazily to keep the module
 * graph acyclic (session.ts depends on prismaBase, never the extended
 * client, so this never recurses through the extension).
 */
export async function resolveAmbientTenantId(): Promise<string | null> {
  const token = await readSessionToken();
  if (!token) return null;

  const cached = tenantByToken.get(token);
  if (cached) return cached;

  const { getCurrentUser } = await import("@/lib/auth/session");
  const user = await getCurrentUser().catch(() => null);
  if (!user) return null;

  if (tenantByToken.size > 10_000) tenantByToken.clear();
  tenantByToken.set(token, user.tenantId);
  return user.tenantId;
}

let warnedModels: Set<string> | null = null;

function warnBootstrapFallbackOnce(model: string, operation: string): void {
  if (process.env.NODE_ENV === "test") return;
  warnedModels ??= new Set();
  if (warnedModels.has(model)) return;
  warnedModels.add(model);
  console.warn(
    `[tenant] no tenant context for ${model}.${operation} — falling back to "${BOOTSTRAP_TENANT_ID}". ` +
      `Every hit is a path not yet wired for Phase 2; safe only while a single tenant exists.`
  );
}

export interface ResolvedTenant {
  /** null means "unscoped" — the extension must not filter. */
  readonly tenantId: string | null;
  readonly source: "directive" | "unscoped" | "session" | "fallback";
}

/**
 * Resolves the tenant the Prisma extension should enforce for one
 * operation, in strict precedence: explicit directive → ambient session →
 * bootstrap fallback (logged once per model).
 */
export async function resolveActiveTenant(
  model: string,
  operation: string
): Promise<ResolvedTenant> {
  const directive = getTenantDirective();
  if (directive?.mode === "unscoped") return { tenantId: null, source: "unscoped" };
  if (directive?.mode === "scoped") return { tenantId: directive.tenantId, source: "directive" };

  const sessionTenantId = await resolveAmbientTenantId();
  if (sessionTenantId) return { tenantId: sessionTenantId, source: "session" };

  warnBootstrapFallbackOnce(model, operation);
  return { tenantId: BOOTSTRAP_TENANT_ID, source: "fallback" };
}

/**
 * The active tenant id for a raw-SQL query that CAN be made genuinely
 * tenant-safe by adding an explicit `tenantId` predicate (Phase 3 —
 * docs/adr/0025), instead of merely being guarded to the bootstrap tenant.
 * Throws if the context is unscoped: every current caller is a normal,
 * session-scoped read that must never run unscoped.
 */
export async function resolveActiveTenantIdForRawSql(label: string): Promise<string> {
  const { tenantId, source } = await resolveActiveTenant("(raw)", label);
  if (source === "unscoped" || tenantId === null) {
    throw new Error(`[tenant] ${label}: this raw-SQL path cannot run unscoped.`);
  }
  return tenantId;
}

/** Thrown when a tenant-owned CREATE has no directive and no session — see
 * `resolveActiveTenant`'s write guard below (docs/adr/0025). */
export class TenantContextRequiredError extends Error {
  constructor(model: string, operation: string) {
    super(
      `[tenant] ${model}.${operation}: refusing to create a record with no tenant context ` +
        `(no directive, no session). Wrap the caller in runWithTenant()/runUnscoped(), or make sure ` +
        `the request has a logged-in session.`
    );
    this.name = "TenantContextRequiredError";
  }
}

/**
 * Same precedence as `resolveActiveTenant`, but for an operation that
 * would CREATE a new tenant-owned row. Phase 2 let a missing context
 * silently fall back to the bootstrap tenant for every operation,
 * including creates (docs/adr/0024, "No directive and no session" bypass).
 * Phase 3 closes that for creates specifically — "new business records
 * must no longer silently fall into tenant 'default'" — by throwing
 * instead of falling back.
 *
 * Carved out in the test environment: the whole existing test suite
 * deliberately exercises bare `prisma.x.create()` fixtures with no
 * session/directive (ADR 0024 already called this out as a legitimate
 * "most unit tests" bypass consumer), and every real runtime create path
 * already has a session or an explicit `runWithTenant`/`runUnscoped`
 * directive (Server Actions, the two webhook routes, login). A dedicated
 * adversarial test (tests/lib/tenant-phase3.test.ts) proves the throw
 * path itself by stubbing NODE_ENV.
 */
export async function resolveActiveTenantForCreate(
  model: string,
  operation: string
): Promise<ResolvedTenant> {
  const directive = getTenantDirective();
  if (directive?.mode === "unscoped") return { tenantId: null, source: "unscoped" };
  if (directive?.mode === "scoped") return { tenantId: directive.tenantId, source: "directive" };

  const sessionTenantId = await resolveAmbientTenantId();
  if (sessionTenantId) return { tenantId: sessionTenantId, source: "session" };

  if (process.env.NODE_ENV !== "test") {
    throw new TenantContextRequiredError(model, operation);
  }

  warnBootstrapFallbackOnce(model, operation);
  return { tenantId: BOOTSTRAP_TENANT_ID, source: "fallback" };
}
