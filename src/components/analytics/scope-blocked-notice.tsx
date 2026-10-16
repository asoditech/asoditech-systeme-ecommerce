import Link from "next/link";
import { FilterX } from "lucide-react";
import { Notice } from "@/components/ui/notice";
import { analyticsQuery, type AnalyticsFilters } from "@/lib/analytics/filters";
import type { AnalyticsPeriod } from "@/lib/analytics/period";
import { blockedReason, unsupportedFilters, withoutDimensions, SCOPE_DIMENSION_LABELS, type AnalyticsBlock } from "@/lib/analytics/scope";

/**
 * Shown IN PLACE of an analytics section the active filters cannot narrow
 * (see `src/lib/analytics/scope.ts`) — the section is not computed, so no
 * global figure ever sits next to filtered ones. Offers a link that removes
 * only the blocking filters (period and the other filters kept).
 */
export function ScopeBlockedNotice({
  block,
  title,
  basePath,
  period,
  filters,
}: {
  block: AnalyticsBlock;
  title: string;
  basePath: string;
  period: AnalyticsPeriod;
  filters: AnalyticsFilters;
}) {
  const dims = unsupportedFilters(block, filters);
  if (dims.length === 0) return null;
  const href = `${basePath}?${analyticsQuery(period, withoutDimensions(filters, dims))}`;
  return (
    <section className="space-y-2" data-scope-blocked={block}>
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      <Notice tone="hint" role="note">
        <FilterX aria-hidden />
        <span>
          {blockedReason(block, dims)}{" "}
          <Link href={href} className="font-medium underline-offset-2 hover:underline">
            Retirer le filtre {dims.map((d) => SCOPE_DIMENSION_LABELS[d]).join(" / ")}
          </Link>
        </span>
      </Notice>
    </section>
  );
}
