import "server-only";

import { prisma } from "@/lib/prisma";
import { notify } from "@/lib/notifications";
import { recordAuditEvent } from "@/lib/audit";
import { ALERT_THRESHOLDS } from "./catalogue";
import { currentPeriod, type MetricUsage } from "./usage";
import type { UsageMetric } from "@prisma/client";

/**
 * Request-driven, de-duplicated usage-threshold alerts — see
 * docs/adr/0035-plans-entitlements-usage.md "Alerts". No background job or
 * cron system exists anywhere in this codebase (confirmed repo-wide), so
 * this runs at the moment usage actually changes — call it right after
 * the write that could have moved a metric across a threshold (an order
 * created, an invitation accepted, a warehouse created), the exact same
 * pattern `checkAndNotifyLowStock` already uses for inventory
 * (docs/adr/0016). Best-effort: every failure is logged and swallowed,
 * never allowed to fail the action that triggered it.
 *
 * De-duplication: `UsageAlertState.highestThresholdNotified` only ever
 * advances upward. A page refresh, or an unrelated write in the same
 * period, recomputes the same status and finds nothing higher to notify —
 * a pure no-op, not a repeat alert. Resets naturally at the start of a new
 * calendar month for ORDERS (a fresh `period` string has no existing row);
 * USERS/WAREHOUSES use the literal period `"current"` and so do NOT
 * auto-reset — removing a user/warehouse and dropping back under a
 * threshold, then crossing it again later, intentionally does not re-fire
 * (avoiding alert flapping) unless a platform admin resets the state
 * directly, which this phase does not build a UI for.
 */

const METRIC_LABEL: Record<UsageMetric, string> = {
  ORDERS: "commandes",
  USERS: "utilisateurs",
  WAREHOUSES: "entrepôts",
};

function periodFor(metric: UsageMetric): string {
  return metric === "ORDERS" ? currentPeriod() : "current";
}

/** The highest threshold `usage.percent` has crossed, or `null` if under 80%. */
function highestCrossedThreshold(usage: MetricUsage): number | null {
  if (usage.limit === null || usage.percent === null) return null;
  let highest: number | null = null;
  for (const t of ALERT_THRESHOLDS) {
    if (usage.percent >= t) highest = t;
  }
  return highest;
}

/**
 * Checks one metric's usage against its plan limit and fires an in-app
 * notification + audit event the first time (and only the first time) a
 * higher threshold (80/90/100) is crossed within the current period.
 * Safe to call unconditionally after any write that could have changed
 * the metric — a call that finds nothing new to report is a cheap no-op
 * (one indexed upsert-check, no notification fan-out).
 */
export async function checkAndNotifyUsageThreshold(tenantId: string, metric: UsageMetric, usage: MetricUsage): Promise<void> {
  try {
    const crossed = highestCrossedThreshold(usage);
    if (crossed === null) return;

    const period = periodFor(metric);
    const existing = await prisma.usageAlertState.findUnique({
      where: { tenantId_metric_period: { tenantId, metric, period } },
    });
    if (existing && existing.highestThresholdNotified >= crossed) return;

    await prisma.usageAlertState.upsert({
      where: { tenantId_metric_period: { tenantId, metric, period } },
      update: { highestThresholdNotified: crossed },
      create: { tenantId, metric, period, highestThresholdNotified: crossed },
    });

    const label = METRIC_LABEL[metric];
    const title =
      crossed >= 100
        ? `Limite de ${label} atteinte`
        : `Vous approchez de votre limite de ${label}`;
    const message =
      crossed >= 100
        ? `Vous avez utilisé ${usage.used}/${usage.limit} ${label} ce mois-ci — la limite de votre forfait est atteinte.`
        : `Vous avez utilisé ${usage.used}/${usage.limit} ${label}, soit ${usage.percent}% de votre forfait.`;

    await notify({
      type: "USAGE_LIMIT_ALERT",
      title,
      message,
      entityType: "TenantSubscription",
      entityId: tenantId,
      dedupeKey: `usage_limit:${metric}:${period}:${crossed}`,
      recipientPermission: "settings.manage",
    });

    await recordAuditEvent({
      actorType: "SYSTEM",
      action: "usage.threshold_reached",
      entityType: "TenantSubscription",
      entityId: tenantId,
      metadata: { metric, period, threshold: crossed, used: usage.used, limit: usage.limit },
    });
  } catch (error) {
    console.error("checkAndNotifyUsageThreshold() failed (non-fatal):", error);
  }
}
