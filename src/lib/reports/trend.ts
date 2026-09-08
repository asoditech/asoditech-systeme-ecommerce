/**
 * A period-over-period delta (percent, from `deltaPct`) turned into the
 * `trend` prop `KpiCard` expects. `invert` is for metrics where down is
 * good (return rate, delivery cost) so the color still reads correctly.
 */
export function trendFromDelta(
  delta: number | null,
  opts: { invert?: boolean } = {}
): { direction: "up" | "down" | "flat"; label: string } | undefined {
  if (delta === null) return undefined;
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const good = opts.invert ? rounded < 0 : rounded > 0;
  const bad = opts.invert ? rounded > 0 : rounded < 0;
  return {
    direction: good ? "up" : bad ? "down" : "flat",
    label: `${sign}${rounded} % vs période préc.`,
  };
}
