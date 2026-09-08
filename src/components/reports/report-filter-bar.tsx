import Link from "next/link";
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

  return (
    <div className="mb-5 flex flex-wrap items-end gap-2 print:hidden">
      {!hidePeriod && (
        <>
          <div className="flex gap-1.5">
            {presets.map((p) => (
              <Button
                key={p.key}
                size="sm"
                variant={resolved.key === p.key ? "default" : "outline"}
                render={<Link href={presetHref(p.key)} />}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <form className="flex flex-wrap items-end gap-2" action={basePath}>
            {Object.entries(extraParams ?? {}).map(([k, v]) =>
              v ? <input key={k} type="hidden" name={k} value={v} /> : null
            )}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Du</label>
              <Input type="date" name="from" defaultValue={resolved.params.from} className="w-40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground">Au</label>
              <Input type="date" name="to" defaultValue={resolved.params.to} className="w-40" />
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
            Exporter CSV
          </Button>
        )}
        <PrintButton label="Télécharger PDF" />
      </div>
    </div>
  );
}
