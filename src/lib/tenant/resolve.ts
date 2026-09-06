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
 * Guard for the few raw-SQL query paths that cannot go through the
 * extension (see docs/adr/0024 "Known bypasses"). Throws the moment a
 * non-bootstrap tenant is active, so those paths fail loudly instead of
 * leaking across tenants once provisioning lands.
 */
export async function assertBootstrapTenant(label: string): Promise<void> {
  const { tenantId, source } = await resolveActiveTenant("(raw)", label);
  if (source === "unscoped") return;
  if (tenantId !== BOOTSTRAP_TENANT_ID) {
    throw new Error(
      `[tenant] ${label} is a raw-SQL path with no tenant scoping and cannot run for tenant "${tenantId}". ` +
        `It must be made tenant-aware before onboarding a second tenant.`
    );
  }
}
