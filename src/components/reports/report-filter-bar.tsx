import { Download } from "lucide-react";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PrintButton } from "@/components/reports/print-button";
import type { ResolvedReportRange } from "@/lib/reports/range";

/**
 * Shared period picker for every /rapports page. Server component: the
 * presets are plain links (`?period=…`) and the custom range is a GET
 * `<form>` back to the same path — no client JS beyond the print button.
 * `extra` slots in a report-specific control (e.g. the warehouse select
 * on stock valuation). Hidden in print output.
 */
export function ReportFilterBar({
  basePath,
  resolved,
  exportHref,
  extraParams,
  extra,
  hidePeriod = false,
}: {
  basePath: string;
  resolved: ResolvedReportRange;
  exportHref?: string;
  /** Non-period query params to preserve across preset clicks (e.g. warehouseId). */
  extraParams?: Record<string, string | undefined>;
  extra?: React.ReactNode;
  /** Stock valuation is a live snapshot, not a windowed report — it hides
   * the date controls and shows only its own filter + the export/print. */
  hidePeriod?: boolean;
}) {
  const presets = [
    { key: "month", label: "Ce mois" },
    { key: "quarter", label: "Ce trimestre" },
    { key: "year", label: "Cette année" },
  ] as const;

  const preserved = new URLSearchParams();
  for (const [k, v] of Object.entries(extraParams ?? {})) if (v) preserved.set(k, v);
  const presetHref = (key: string) => {
    const sp = new URLSearchParams(preserved);
    sp.set("period", key);
    return `${basePath}?${sp.toString()}`;
  };

  // Phase 5 visual QA: one toolbar surface — period presets as a segmented
  // control (a position, not a primary action), the custom range beside it,
  // export/print pushed right. The only solid-orange element on a report is
  // no longer "which month am I looking at".
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-card p-2 shadow-card ring-1 ring-border print:hidden">
      {!hidePeriod && (
        <>
          <SegmentedControl>
            {presets.map((p) => (
              <SegmentedControlItem key={p.key} active={resolved.key === p.key} href={presetHref(p.key)}>
                {p.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>

          <form className="flex flex-wrap items-center gap-2" action={basePath}>
            {Object.entries(extraParams ?? {}).map(([k, v]) =>
              v ? <input key={k} type="hidden" name={k} value={v} /> : null
            )}
            <div className="flex items-center gap-1.5">
              <label htmlFor="report-from" className="text-xs font-medium text-muted-foreground">
                Du
              </label>
              <Input id="report-from" type="date" name="from" defaultValue={resolved.params.from} className="h-8 w-38" />
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="report-to" className="text-xs font-medium text-muted-foreground">
                Au
              </label>
              <Input id="report-to" type="date" name="to" defaultValue={resolved.params.to} className="h-8 w-38" />
            </div>
            <Button type="submit" size="sm" variant="outline">
              Appliquer
            </Button>
          </form>
        </>
      )}

      {extra}

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
  );
}
