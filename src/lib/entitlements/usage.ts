import "server-only";

import { prismaBase } from "@/lib/prisma";
import { computeUsageStatus, usagePercent, type UsageStatus } from "./catalogue";
import { getTenantPlan } from "./plan";

/**
 * Usage metering — see docs/adr/0035-plans-entitlements-usage.md "Usage
 * metering". Every number here is a live, indexed COUNT against the
 * authoritative table (`orders`/`users`/`warehouses`) for the given
 * `tenantId`, computed with an EXPLICIT tenantId predicate via
 * `prismaBase` (never the ambient-session-scoped `prisma` client) —
 * required so a platform admin can compute any tenant's usage, not just
 * their own. Callers are responsible for authorizing that tenantId (the
 * client-facing page always passes the caller's own session tenantId; the
 * platform pages are already gated by `requirePlatformAdmin`).
 *
 * There is deliberately NO separate "usage counter" table incrementally
 * maintained alongside these — a stored counter can drift from reality
 * (a retried request, a rolled-back transaction, a bug); a live COUNT
 * against the same rows the rest of the app already treats as
 * authoritative cannot drift, by construction. This is the literal
 * reading of the brief's "usage must be based on authoritative database
 * state." At the tenant counts this app is built for (10-500 tenants,
 * each independently indexed), this is also simply cheap: a single
 * indexed range-scan COUNT per metric, not a table scan, and never
 * computed on a normal page request that isn't the tenant's own usage
 * page or the platform's own monitoring pages.
 */

/** "YYYY-MM" for the given date in UTC — the one period definition used
 * everywhere usage is bucketed by calendar month. */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function periodRange(period: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

export interface MetricUsage {
  used: number;
  limit: number | null;
  status: UsageStatus;
  percent: number | null;
}

export interface TenantUsage {
  period: string;
  orders: MetricUsage;
  users: MetricUsage;
  warehouses: MetricUsage;
  /** Always `null` — no file/object storage exists anywhere in this
   * codebase to meter (confirmed repo-wide: product images are external
   * URLs, backups are downloaded/pushed to the tenant's own Drive, never
   * stored server-side). Kept as an explicit field, not omitted, so the
   * UI can render an honest "Non applicable" instead of silently hiding a
   * row a future storage feature would need — see the Data Integrity
   * Principle (never fabricate a number for something that doesn't
   * exist). */
  storage: null;
}

/**
 * Every order EVER created counts, exactly once, for the calendar month
 * its `placedAt` falls in — regardless of its current `status`
 * (cancelled/refunded orders still represent a real order a customer
 * placed and this system processed; re-deriving "does this still count"
 * from a mutable status would make monthly usage retroactively change
 * long after the fact, which is worse). `placedAt` (not `createdAt`) is
 * used deliberately: a WooCommerce/Shopify import backfills the source
 * platform's real order date into `placedAt`, so importing three years of
 * history attributes each order to ITS OWN historical month rather than
 * inflating the current month's usage the moment a sync runs — see
 * `docs/adr/0002` on `Order.placedAt` vs `createdAt`. No double-counting
 * is possible by construction: every creation path
 * (`createOrderAction`, and both WooCommerce/Shopify import pipelines) is
 * already idempotent by `(tenantId, source, externalId)` / the order form
 * only ever inserting once per submission — a retried request updates an
 * existing row rather than inserting a second one, so a COUNT of rows is
 * never a count of retries.
 */
async function countOrdersInPeriod(tenantId: string, period: string): Promise<number> {
  const { start, end } = periodRange(period);
  return prismaBase.order.count({
    where: { tenantId, placedAt: { gte: start, lt: end } },
  });
}

/** Point-in-time headcount — only `ACTIVE` users hold a seat. A `DISABLED`
 * account frees its seat immediately, same as a real SaaS "seats" model. */
async function countActiveUsers(tenantId: string): Promise<number> {
  return prismaBase.user.count({ where: { tenantId, status: "ACTIVE" } });
}

/** Point-in-time headcount — only `isActive` warehouses count. A retired
 * (deactivated) location frees its slot; its historical `InventoryItem`
 * rows are untouched (docs/adr/0019). */
async function countActiveWarehouses(tenantId: string): Promise<number> {
  return prismaBase.warehouse.count({ where: { tenantId, isActive: true } });
}

export async function getTenantLimits(tenantId: string) {
  const { plan } = await getTenantPlan(tenantId);
  return {
    maxOrdersPerMonth: plan.maxOrdersPerMonth,
    maxUsers: plan.maxUsers,
    maxWarehouses: plan.maxWarehouses,
  };
}

export async function getTenantUsage(tenantId: string, period: string = currentPeriod()): Promise<TenantUsage> {
  const [{ plan }, ordersUsed, usersUsed, warehousesUsed] = await Promise.all([
    getTenantPlan(tenantId),
    countOrdersInPeriod(tenantId, period),
    countActiveUsers(tenantId),
    countActiveWarehouses(tenantId),
  ]);

  return {
    period,
    orders: {
      used: ordersUsed,
      limit: plan.maxOrdersPerMonth,
      status: computeUsageStatus(ordersUsed, plan.maxOrdersPerMonth),
      percent: usagePercent(ordersUsed, plan.maxOrdersPerMonth),
    },
    users: {
      used: usersUsed,
      limit: plan.maxUsers,
      status: computeUsageStatus(usersUsed, plan.maxUsers),
      percent: usagePercent(usersUsed, plan.maxUsers),
    },
    warehouses: {
      used: warehousesUsed,
      limit: plan.maxWarehouses,
      status: computeUsageStatus(warehousesUsed, plan.maxWarehouses),
      percent: usagePercent(warehousesUsed, plan.maxWarehouses),
    },
    storage: null,
  };
}

/**
 * Cross-tenant usage for the platform overview (`/platform`) — one
 * GROUP BY query per metric across every tenant, never an N+1 loop of
 * per-tenant queries. Deliberately not exported for ordinary tenant-facing
 * use; only `/platform` pages (already `requirePlatformAdmin`-gated) call
 * this.
 */
export async function getUsageForAllTenants(period: string = currentPeriod()): Promise<
  Map<string, { orders: number; users: number; warehouses: number }>
> {
  const { start, end } = periodRange(period);
  const [orderGroups, userGroups, warehouseGroups] = await Promise.all([
    prismaBase.order.groupBy({
      by: ["tenantId"],
      where: { placedAt: { gte: start, lt: end } },
      _count: { _all: true },
    }),
    prismaBase.user.groupBy({
      by: ["tenantId"],
      where: { status: "ACTIVE" },
      _count: { _all: true },
    }),
    prismaBase.warehouse.groupBy({
      by: ["tenantId"],
      where: { isActive: true },
      _count: { _all: true },
    }),
  ]);

  const result = new Map<string, { orders: number; users: number; warehouses: number }>();
  const ensure = (tenantId: string) => {
    let entry = result.get(tenantId);
    if (!entry) {
      entry = { orders: 0, users: 0, warehouses: 0 };
      result.set(tenantId, entry);
    }
    return entry;
  };
  for (const g of orderGroups) ensure(g.tenantId).orders = g._count._all;
  for (const g of userGroups) ensure(g.tenantId).users = g._count._all;
  for (const g of warehouseGroups) ensure(g.tenantId).warehouses = g._count._all;
  return result;
}
