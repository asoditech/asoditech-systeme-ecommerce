import "server-only";

import { requirePermission } from "@/lib/auth/guards";
import type { CurrentUser } from "@/lib/auth/session";
import { analyticsAccess, requireSection, type AnalyticsAccess, type AnalyticsSection } from "@/lib/analytics/access";
import { resolveAnalyticsPeriod, type AnalyticsPeriod } from "@/lib/analytics/period";
import { analyticsParams, parseAnalyticsFilters, type AnalyticsFilters } from "@/lib/analytics/filters";

export interface AnalyticsContext {
  user: CurrentUser;
  access: AnalyticsAccess;
  period: AnalyticsPeriod;
  filters: AnalyticsFilters;
  /** period + filters + sort, for links and the CSV export. */
  params: Record<string, string>;
  /** filters + sort only (no period) — preserved by the period controls. */
  filterParams: Record<string, string>;
  /** period only — carried across sections. */
  periodQuery: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The single entry point of every analytics page AND export: authenticate,
 * require `analytics.view`, resolve what this viewer may read, refuse the
 * section if nothing in it is readable, then parse period + filters.
 */
export async function analyticsContext(searchParams: SearchParams, section: AnalyticsSection): Promise<AnalyticsContext> {
  const user = await requirePermission("analytics.view");
  const access = analyticsAccess(user);
  requireSection(access, section);
  return contextFor(user, access, searchParams);
}

export function contextFor(user: CurrentUser, access: AnalyticsAccess, searchParams: SearchParams): AnalyticsContext {
  const one = (k: string) => {
    const v = searchParams[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const period = resolveAnalyticsPeriod({ period: one("period"), from: one("from"), to: one("to") });
  const filters = parseAnalyticsFilters(searchParams);
  const params = analyticsParams(period, filters);
  const filterParams = Object.fromEntries(Object.entries(params).filter(([k]) => !["period", "from", "to"].includes(k)));
  return { user, access, period, filters, params, filterParams, periodQuery: new URLSearchParams(period.params as Record<string, string>).toString() };
}
