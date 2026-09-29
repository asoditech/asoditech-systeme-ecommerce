import { RankedMetricList } from "@/components/ranked-metric-list";
import { formatCurrency } from "@/lib/format";
import type { TopSellingUnit } from "@/lib/queries/analytics";

/**
 * Dashboard "Meilleures ventes" — a thin adapter over the generic
 * `RankedMetricList` (Phase 2 UI refinement). Reuses `getTopSellingUnits`'s
 * already-safe metric (see that function's doc comment for exactly what's
 * measured); this component only shapes it for display, no numbers
 * computed here.
 */
export function TopSellingProducts({ units }: { units: TopSellingUnit[] }) {
  return (
    <RankedMetricList
      items={units.map((u) => ({
        key: u.key,
        imageUrl: u.imageUrl,
        primary: u.productName,
        secondary: u.variantLabel,
        metric: u.unitsSold,
        value: String(u.unitsSold),
        valueHint: formatCurrency(String(u.revenue)),
      }))}
    />
  );
}
