import "server-only";

import { prisma, prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";
import { parsePlanFeatures, type PlanFeatures } from "./catalogue";
import type { Plan, SubscriptionStatus } from "@prisma/client";

/**
 * Reads a tenant's current plan + subscription — see
 * docs/adr/0035-plans-entitlements-usage.md. Every real tenant has exactly
 * one `TenantSubscription` row (created by `provisionTenantBaseline` for a
 * new tenant, backfilled for every pre-existing one by this feature's own
 * migration). A tenant with no row at all — a fixture created directly by
 * `prismaBase.tenant.create(...)` in a test, bypassing normal provisioning
 * — falls back to the BUSINESS plan rather than throwing, exactly like
 * `resolveActiveTenant`'s own bootstrap-fallback philosophy (docs/adr/0024):
 * defaulting sensibly is safer than crashing every unrelated code path that
 * happens to touch a tenant nobody explicitly assigned a plan to yet.
 */
export interface TenantPlanInfo {
  plan: Plan;
  features: PlanFeatures;
  subscriptionStatus: SubscriptionStatus;
  /** Null only for the fallback case described above — a real subscription always has one. */
  currentPlanSince: Date | null;
}

let fallbackWarned = false;

async function loadBusinessPlanFallback(): Promise<Plan> {
  // Plan is a global catalogue (no tenantId) — always read via the raw
  // client, never through the tenant-scoping extension, exactly like
  // Tenant itself (docs/adr/0024's own reasoning for `prismaBase`).
  const plan = await prismaBase.plan.findUnique({ where: { code: "BUSINESS" } });
  if (!plan) {
    throw new Error(
      "No BUSINESS plan row exists — the plans_entitlements_usage migration must run before any entitlement check can succeed."
    );
  }
  return plan;
}

export async function getTenantPlan(tenantId: string): Promise<TenantPlanInfo> {
  const subscription = await runUnscoped("entitlements:get-plan", () =>
    prismaBase.tenantSubscription.findUnique({
      where: { tenantId },
      include: { plan: true },
    })
  );

  if (!subscription) {
    if (!fallbackWarned) {
      fallbackWarned = true;
      console.warn(
        `getTenantPlan(): tenant "${tenantId}" has no TenantSubscription row — falling back to BUSINESS. ` +
          "This is expected for a fixture/test tenant created without provisionTenantBaseline; " +
          "a real tenant should always have one."
      );
    }
    const plan = await loadBusinessPlanFallback();
    return {
      plan,
      features: parsePlanFeatures(plan.features),
      subscriptionStatus: "ACTIVE",
      currentPlanSince: null,
    };
  }

  return {
    plan: subscription.plan,
    features: parsePlanFeatures(subscription.plan.features),
    subscriptionStatus: subscription.status,
    currentPlanSince: subscription.currentPlanSince,
  };
}

/** BUSINESS and PRO only — the plans a new tenant can self-select /
 * compare (see docs/adr/0035). Excludes CUSTOM: that plan is never
 * advertised or self-serve, only hand-assigned to a specific tenant by a
 * platform admin via `listAllPlans`/`changeTenantPlanAction`. */
export async function listOfferedPlans(): Promise<Plan[]> {
  return prismaBase.plan.findMany({
    where: { code: { in: ["BUSINESS", "PRO"] } },
    orderBy: { sortOrder: "asc" },
  });
}

/** Every plan row, including CUSTOM — for `/platform/plans`, the
 * platform-admin editor where prices/limits/features are centrally
 * defined for every plan that can be assigned, bespoke ones included. */
export async function listAllPlans(): Promise<Plan[]> {
  return prismaBase.plan.findMany({ orderBy: { sortOrder: "asc" } });
}

export async function getPlanByCode(code: "BUSINESS" | "PRO" | "CUSTOM") {
  return prismaBase.plan.findUnique({ where: { code } });
}

/** The tenant's own subscription row, tenant-scoped read (used by the
 * client-facing Abonnement & Utilisation page — reuses the regular,
 * RLS-protected `prisma` client since this is "my own" data, not a
 * cross-tenant platform read). */
export async function getOwnSubscription(tenantId: string) {
  return prisma.tenantSubscription.findUnique({
    where: { tenantId },
    include: { plan: true },
  });
}
