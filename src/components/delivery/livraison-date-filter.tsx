"use client";

import { DateRangeFilter } from "@/components/date-range-filter";
import type { DateRangePreset } from "@/lib/date-range-presets";

/**
 * The Livraison "période" filter — the shared DateRangeFilter with the
 * delivery wording (filters on the shipment's CREATION date). Same URL
 * params as before (`range`, `dateFrom`, `dateTo`, kept page sizes).
 */
export function LivraisonDateFilter({
  initialRange,
  initialFrom,
  initialTo,
  keepParams,
}: {
  initialRange: DateRangePreset;
  initialFrom?: string;
  initialTo?: string;
  /** Display preferences carried over a filter change (e.g. the tables'
   * page sizes) — the page cursors themselves are reset to 1. */
  keepParams?: Record<string, string | undefined>;
}) {
  return (
    <DateRangeFilter
      basePath="/livraison"
      initialRange={initialRange}
      initialFrom={initialFrom}
      initialTo={initialTo}
      label="Expéditions créées"
      labelTitle="Date à laquelle l'expédition a été créée — pas la date de la commande."
      ariaSubject="Expéditions créées"
      keepParams={keepParams}
    />
  );
}
