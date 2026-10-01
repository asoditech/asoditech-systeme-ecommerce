import { Download } from "lucide-react";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterSelect } from "@/components/filter-select";
import { PrintButton } from "@/components/reports/print-button";
import { ANALYTICS_PERIODS, ANALYTICS_PERIOD_LABELS, type AnalyticsPeriod } from "@/lib/analytics/period";

export interface AnalyticsFilterControl {
  paramKey: string;
  value?: string;
  allLabel: string;
  options: { value: string; label: string }[];
}

/**
 * Period + filter toolbar for every analytics section. Server component:
 * presets are links that keep the current filters, the custom range is a
 * GET form, and each filter is a `FilterSelect` that rewrites the URL — so
 * every view is shareable. The options offered are already limited to what
 * the viewer may read; the queries re-apply the scope regardless.
 */
export function AnalyticsFilterBar({
  basePath,
  period,
  filterParams,
  controls = [],
  exportHref,
}: {
  basePath: string;
  period: AnalyticsPeriod;
  /** Current non-period params (filters, sort) — preserved by the presets and the custom form. */
  filterParams: Record<string, string>;
  controls?: AnalyticsFilterControl[];
  exportHref?: string;
}) {
  const presetHref = (key: string) => {
    const sp = new URLSearchParams(filterParams);
    sp.set("period", key);
    return `${basePath}?${sp.toString()}`;
  };
  return (
    <div className="mb-5 space-y-2 rounded-xl bg-card p-2 shadow-card ring-1 ring-border print:hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl>
          {ANALYTICS_PERIODS.map((key) => (
            <SegmentedControlItem key={key} active={period.key === key} href={presetHref(key)}>
              {ANALYTICS_PERIOD_LABELS[key]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <form className="flex flex-wrap items-center gap-2" action={basePath}>
          {Object.entries(filterParams).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label htmlFor="analytics-from" className="text-xs font-medium text-muted-foreground">
            Du
          </label>
          <Input id="analytics-from" type="date" name="from" defaultValue={period.params.from} className="h-8 w-38" required />
          <label htmlFor="analytics-to" className="text-xs font-medium text-muted-foreground">
            Au
          </label>
          <Input id="analytics-to" type="date" name="to" defaultValue={period.params.to} className="h-8 w-38" required />
          <Button type="submit" size="sm" variant="outline">
            Appliquer
          </Button>
        </form>
        <div className="ml-auto flex gap-1.5">
          {exportHref && (
            <Button size="sm" variant="outline" render={<a href={exportHref} />}>
              <Download className="size-3.5" />
              Exporter CSV
            </Button>
          )}
          <PrintButton label="Télécharger PDF" />
        </div>
      </div>
      {controls.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {controls.map((c) => (
            <FilterSelect key={c.paramKey} paramKey={c.paramKey} value={c.value} options={c.options} allLabel={c.allLabel} ariaLabel={c.allLabel} className="h-8 w-auto min-w-44" />
          ))}
        </div>
      )}
    </div>
  );
}
