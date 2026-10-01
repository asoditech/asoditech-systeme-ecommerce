/**
 * A conversion funnel: each step's bar is its share of the FIRST step (not of
 * the sum, unlike `BreakdownBarList`). Plain CSS — four rows, not a chart.
 */
export function FunnelBars({ steps }: { steps: { label: string; count: number; hint?: string }[] }) {
  const base = steps[0]?.count ?? 0;
  return (
    <div className="space-y-3">
      {steps.map((s) => {
        const share = base > 0 ? (s.count / base) * 100 : 0;
        return (
          <div key={s.label}>
            <div className="mb-1 flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{s.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {s.count}
                {base > 0 && <span className="ml-1 text-xs">({share.toFixed(1).replace(".", ",")} %)</span>}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
            </div>
            {s.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{s.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}
