import "server-only";

import { prismaBase } from "@/lib/prisma";
import { computeUsageStatus, type UsageStatus } from "@/lib/entitlements/catalogue";
import { getUsageForAllTenants, currentPeriod } from "@/lib/entitlements/usage";
import type { PlanCode, SubscriptionStatus, TenantStatus } from "@prisma/client";

/**
 * Cross-tenant reads for `/platform` (docs/adr/0035 "Platform monitoring")
 * — every function here is unscoped (`prismaBase`) by design, since this
 * IS the legitimate cross-tenant view. Callers must be
 * `requirePlatformAdmin`-gated pages/actions; nothing here re-checks that
 * itself (same convention as `listTenantsForPlatform` in
 * src/actions/tenants.ts). Deliberately a small, fixed number of
 * GROUP BY/aggregate queries — never one query per tenant — so this stays
 * fast regardless of tenant count (10, 50, 100, 500 — see docs/adr/0035
 * "Performance").
 */

export interface PlatformTenantRow {
  id: string;
  name: string;
  slug: string;
  tenantStatus: TenantStatus;
  createdAt: Date;
  planCode: PlanCode;
  planName: string;
  subscriptionStatus: SubscriptionStatus;
  users: { used: number; limit: number | null; status: UsageStatus };
  warehouses: { used: number; limit: number | null; status: UsageStatus };
  orders: { used: number; limit: number | null; status: UsageStatus };
  /** The most severe of the three metric statuses — drives the row's
   * "Usage status" badge and the overview's "near/over limit" counts. */
  overallStatus: UsageStatus;
  /** Most recent audit event for this tenant, from ANY actor (staff or
   * platform admin) — a cheap proxy for "last activity" that reuses the
   * existing audit trail rather than a new tracked column. `null` for a
   * tenant with no audit history yet (freshly provisioned, never used). */
  lastActivityAt: Date | null;
}

const STATUS_SEVERITY: Record<UsageStatus, number> = { NORMAL: 0, WARNING: 1, CRITICAL: 2, LIMIT_REACHED: 3 };
function mostSevere(a: UsageStatus, b: UsageStatus): UsageStatus {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a;
}

/**
 * Every tenant, its plan, subscription status, and current-period usage —
 * one query for tenants+subscriptions+plans (a single join), plus the
 * three GROUP BY aggregates from `getUsageForAllTenants` (also one query
 * each, across every tenant at once). No per-tenant query loop anywhere
 * in this function.
 */
export async function listTenantsWithUsage(period: string = currentPeriod()): Promise<PlatformTenantRow[]> {
  const [tenants, usageByTenant, lastActivityGroups] = await Promise.all([
    prismaBase.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: { subscription: { include: { plan: true } } },
    }),
    getUsageForAllTenants(period),
    prismaBase.auditEvent.groupBy({ by: ["tenantId"], _max: { createdAt: true } }),
  ]);
  const lastActivityByTenant = new Map(lastActivityGroups.map((g) => [g.tenantId, g._max.createdAt]));

  return tenants.map((tenant) => {
    const usage = usageByTenant.get(tenant.id) ?? { orders: 0, users: 0, warehouses: 0 };
    // Every tenant should have a subscription (backfilled + auto-created —
    // docs/adr/0035); a fixture tenant created directly in a test without
    // one falls back to showing no plan info rather than crashing the
    // whole platform page over one malformed row.
    const plan = tenant.subscription?.plan ?? null;

    const usersStatus = computeUsageStatus(usage.users, plan?.maxUsers ?? null);
    const warehousesStatus = computeUsageStatus(usage.warehouses, plan?.maxWarehouses ?? null);
    const ordersStatus = computeUsageStatus(usage.orders, plan?.maxOrdersPerMonth ?? null);

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      tenantStatus: tenant.status,
      createdAt: tenant.createdAt,
      planCode: plan?.code ?? "BUSINESS",
      planName: plan?.name ?? "Business",
      subscriptionStatus: tenant.subscription?.status ?? "ACTIVE",
      users: { used: usage.users, limit: plan?.maxUsers ?? null, status: usersStatus },
      warehouses: { used: usage.warehouses, limit: plan?.maxWarehouses ?? null, status: warehousesStatus },
      orders: { used: usage.orders, limit: plan?.maxOrdersPerMonth ?? null, status: ordersStatus },
      overallStatus: mostSevere(mostSevere(usersStatus, warehousesStatus), ordersStatus),
      lastActivityAt: lastActivityByTenant.get(tenant.id) ?? null,
    };
  });
}

export interface PlatformOverview {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  businessTenants: number;
  proTenants: number;
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledSubscriptions: number;
  trialingSubscriptions: number;
  nearLimitTenants: number;
  overLimitTenants: number;
}

/** Derived from the same `listTenantsWithUsage` rows the table already
 * computed — never a second round of queries. */
export function summarizePlatformOverview(rows: PlatformTenantRow[]): PlatformOverview {
  const overview: PlatformOverview = {
    totalTenants: rows.length,
    activeTenants: 0,
    suspendedTenants: 0,
    businessTenants: 0,
    proTenants: 0,
    activeSubscriptions: 0,
    pastDueSubscriptions: 0,
    canceledSubscriptions: 0,
    trialingSubscriptions: 0,
    nearLimitTenants: 0,
    overLimitTenants: 0,
  };

  for (const row of rows) {
    if (row.tenantStatus === "ACTIVE") overview.activeTenants++;
    else overview.suspendedTenants++;

    if (row.planCode === "BUSINESS") overview.businessTenants++;
    else if (row.planCode === "PRO") overview.proTenants++;

    switch (row.subscriptionStatus) {
      case "ACTIVE":
        overview.activeSubscriptions++;
        break;
      case "PAST_DUE":
        overview.pastDueSubscriptions++;
        break;
      case "CANCELED":
        overview.canceledSubscriptions++;
        break;
      case "TRIALING":
        overview.trialingSubscriptions++;
        break;
    }

    if (row.overallStatus === "WARNING" || row.overallStatus === "CRITICAL") overview.nearLimitTenants++;
    if (row.overallStatus === "LIMIT_REACHED") overview.overLimitTenants++;
  }

  return overview;
}

/** Recent plan/subscription changes, from the existing audit trail —
 * reused rather than a parallel history table (docs/adr/0035 "Plan
 * history"). Unscoped: this IS the cross-tenant platform view. */
export async function listRecentPlanChanges(limit = 20) {
  return prismaBase.auditEvent.findMany({
    where: { action: { in: ["plan.assigned", "plan.changed", "subscription.activated", "subscription.suspended", "subscription.canceled"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actorUser: { select: { name: true, email: true } }, tenant: { select: { name: true, slug: true } } },
  });
}
