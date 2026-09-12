import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { getTenantPlan } from "./plan";
import { featureValue, type FeatureKey, type FeatureTier } from "./catalogue";

/**
 * The RBAC/entitlement split — see docs/adr/0035-plans-entitlements-usage.md
 * "Central entitlements system".
 *
 *   hasPermission(user.role, "orders.create")   — is THIS USER allowed?
 *   checkEntitlement(tenantId, "orders")          — does THIS TENANT'S PLAN include it?
 *
 * Both are independent and both matter: a WAREHOUSE-role user is refused
 * by RBAC regardless of plan; a tenant on a plan that lacks a feature is
 * refused by entitlement regardless of role. Neither replaces the other —
 * never delete an RBAC check because an entitlement check was added
 * alongside it, and vice versa.
 */

export class EntitlementDeniedError extends Error {
  constructor(public readonly feature: FeatureKey) {
    super(`Cette fonctionnalité n'est pas incluse dans votre forfait actuel : ${feature}.`);
    this.name = "EntitlementDeniedError";
  }
}

/** Thrown by the hard-limit guards (`assertSeatAvailable`) — carries
 * enough structured detail for the Server Action to build a friendly,
 * upgrade-oriented message rather than a bare "error". */
export class PlanLimitReachedError extends Error {
  constructor(
    public readonly resource: "users" | "warehouses",
    public readonly limit: number,
    public readonly current: number
  ) {
    super(
      `Limite du forfait atteinte pour ${resource} : ${current}/${limit}. ` +
        "Passez à un forfait supérieur pour en ajouter."
    );
    this.name = "PlanLimitReachedError";
  }
}

/** Non-throwing check — boolean features resolve to `true`/`false`;
 * tiered features (`reports`/`profitability`/`backup`) resolve to their
 * tier string ("standard"/"advanced"), always truthy as a feature-enabled
 * signal, but callers wanting the tier itself should read `getTenantPlan`
 * directly rather than this convenience boolean form. */
export async function checkEntitlement(tenantId: string, feature: FeatureKey): Promise<boolean> {
  const { features } = await getTenantPlan(tenantId);
  const value = featureValue(features, feature);
  return value === true || value === "standard" || value === "advanced";
}

/** Resolves a tiered feature's exact tier ("standard"/"advanced") for a
 * tenant — used where the UI needs to SHOW which tier is included, not
 * just whether the feature is on at all (both plans have every tiered
 * feature "on"; the tier is the actual differentiator). */
export async function getFeatureTier(tenantId: string, feature: "reports" | "profitability" | "backup"): Promise<FeatureTier> {
  const { features } = await getTenantPlan(tenantId);
  return features[feature];
}

/** Throws `EntitlementDeniedError` for use in a Server Action, mirroring
 * `requirePermissionForAction`'s throwing style exactly — call this
 * ALONGSIDE (never instead of) the matching `requirePermissionForAction`. */
export async function requireEntitlement(tenantId: string, feature: FeatureKey): Promise<void> {
  const ok = await checkEntitlement(tenantId, feature);
  if (!ok) throw new EntitlementDeniedError(feature);
}

/** Requires a tiered feature to be at least `"advanced"` — not applied to
 * any existing capability today (see catalogue.ts's own comment); this
 * exists so a genuinely new advanced-only feature has a ready enforcement
 * point without inventing one later. */
export async function requireAdvancedTier(tenantId: string, feature: "reports" | "profitability" | "backup"): Promise<void> {
  const tier = await getFeatureTier(tenantId, feature);
  if (tier !== "advanced") {
    throw new EntitlementDeniedError(feature);
  }
}

// ---------------------------------------------------------------------------
// Hard limits — Users & Warehouses (docs/adr/0035 "Limit behaviour").
//
// A deliberate, manual "add a new user/warehouse" action is blocked
// server-side, at the actual write path, the moment it would exceed the
// plan's limit — never only hidden in the UI. Race-safety: the check and
// the create happen inside ONE `prisma.$transaction`, with the Tenant row
// locked first (`SELECT ... FOR UPDATE`) so two concurrent requests for
// the same tenant are serialized — the same "lock the Tenant row" idea
// `src/lib/tenant/numbering.ts` already uses for atomic per-tenant
// counters, adapted here for a COUNT-then-compare instead of a plain
// increment (a stored counter isn't safe for this: users/warehouses can
// also be deactivated, so a derived COUNT is the only thing that can't
// drift from reality).
//
// Orders are deliberately NOT gated this way — see
// docs/adr/0035 "Why orders are a soft limit, never blocking".
// ---------------------------------------------------------------------------

async function lockTenantRow(tx: PrismaTransactionClient, tenantId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "tenants" WHERE id = ${tenantId} FOR UPDATE`;
}

/**
 * Runs `create` inside a transaction that first locks the tenant row and
 * verifies the resource's current count is still under its plan limit —
 * throws `PlanLimitReachedError` before `create` ever runs otherwise.
 * `null` limit (reserved for a future CUSTOM plan) always passes.
 */
export async function withSeatLimit<T>(
  tenantId: string,
  resource: "users" | "warehouses",
  create: (tx: PrismaTransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await lockTenantRow(tx, tenantId);

    // Read the plan through `tx` itself, NOT the standalone `getTenantPlan()`
    // helper — that helper reads via `prismaBase` (bypass-RLS client), and
    // calling a *different* PrismaClient's bypass path from inside an
    // already-open `prisma.$transaction` callback hits a real edge case in
    // the RLS transaction-nesting logic (docs/adr/0026 §3's
    // `isInsideRlsTransaction` marker is keyed off the async context, not
    // the specific client instance): the nested `prismaBase` call sees the
    // marker already set, skips (re-)setting its own bypass GUC, and ends
    // up running with NEITHER `app.bypass_rls` nor `app.tenant_id` set on
    // its own separate connection — RLS's default-deny then returns zero
    // rows. `tx.tenantSubscription`/`tx.plan` reads stay on the SAME
    // connection/transaction that already has the correct `app.tenant_id`
    // GUC set (by this very `$transaction` call), so they resolve
    // correctly with no bypass needed at all. `Plan` itself carries no
    // tenantId and passes through untouched either way (same as
    // `src/lib/tenant/provision.ts`'s own `tx.plan.findUnique`).
    const subscription = await tx.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
    const plan = subscription?.plan ?? (await tx.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } }));
    const limit = resource === "users" ? plan.maxUsers : plan.maxWarehouses;

    if (limit !== null) {
      const current =
        resource === "users"
          ? await tx.user.count({ where: { tenantId, status: "ACTIVE" } })
          : await tx.warehouse.count({ where: { tenantId, isActive: true } });
      if (current >= limit) {
        throw new PlanLimitReachedError(resource, limit, current);
      }
    }

    return create(tx);
  });
}
