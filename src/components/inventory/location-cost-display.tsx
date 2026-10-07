import { formatCurrency } from "@/lib/format";
import { LOCATION_COST_LABELS, locationCostSourceLabel, type LocationCostSource } from "@/lib/catalog/location-cost-labels";

/**
 * Read-only purchase cost of one stock location: the amount and where it comes
 * from (this location's own cost, or the global product cost). Never a selling
 * price. Callers render it only for `finance.view` users.
 */
export function LocationCostDisplay({ cost, source }: { cost: string | null; source: LocationCostSource }) {
  if (cost === null) return <span className="text-muted-foreground">{LOCATION_COST_LABELS.missing}</span>;
  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="tabular-nums">{formatCurrency(cost)}</span>
      <span className={source === "location" ? "text-xs font-medium text-primary" : "text-xs text-muted-foreground"}>
        {locationCostSourceLabel(source)}
      </span>
    </span>
  );
}
