"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DateRangeFields } from "@/components/date-range-fields";
import { DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";
import { buildDateRangeQuery } from "@/lib/date-range-query";

/**
 * A generic "période" filter (Aujourd'hui/Hier/Ce mois/…/Personnalisée) —
 * query-string convention `range`, `dateFrom`, `dateTo` (unchanged), with a
 * `basePath` so any page can reuse it (/livraison through
 * LivraisonDateFilter, /confirmation/performance). The custom range uses the
 * shared DateRangeFields control.
 */
export interface DateRangeFilterProps {
  basePath: string;
  initialRange: DateRangePreset;
  initialFrom?: string;
  initialTo?: string;
  defaultRange?: DateRangePreset;
  label?: string;
  labelTitle?: string;
  /** Accessible names of the controls, e.g. « Expéditions créées ». */
  ariaSubject?: string;
  /** Display preferences carried over a filter change (e.g. page sizes). */
  keepParams?: Record<string, string | undefined>;
}

export function DateRangeFilter(props: DateRangeFilterProps) {
  // Re-keyed on the URL state: a soft navigation never leaves stale choices.
  return <DateRangeFilterInner key={`${props.initialRange}|${props.initialFrom ?? ""}|${props.initialTo ?? ""}`} {...props} />;
}

function DateRangeFilterInner({
  basePath,
  initialRange,
  initialFrom,
  initialTo,
  defaultRange = "all",
  label = "Période",
  labelTitle,
  ariaSubject,
  keepParams,
}: DateRangeFilterProps) {
  const router = useRouter();
  const [range, setRange] = useState<DateRangePreset>(initialRange);
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  const isFiltered = range !== defaultRange || Boolean(from || to);

  function go(qs: string) {
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-ink-muted" title={labelTitle}>
        {label}
      </label>
      <Select value={range} onValueChange={(v) => v && setRange(v as DateRangePreset)}>
        <SelectTrigger className="w-52" aria-label={ariaSubject ? `Période — ${ariaSubject}` : label}>
          <SelectValue>{(value: string) => DATE_RANGE_PRESET_LABELS[value as DateRangePreset] ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(DATE_RANGE_PRESET_LABELS) as DateRangePreset[]).map((p) => (
            <SelectItem key={p} value={p}>
              {DATE_RANGE_PRESET_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {range === "custom" && (
        <DateRangeFields
          idPrefix={`${basePath.replace(/\W+/g, "-")}-range`}
          from={initialFrom}
          to={initialTo}
          fromAriaLabel={ariaSubject ? `${ariaSubject} à partir du` : undefined}
          toAriaLabel={ariaSubject ? `${ariaSubject} jusqu'au` : undefined}
          onChange={(r) => {
            setFrom(r.from);
            setTo(r.to);
          }}
        />
      )}

      <Button type="button" variant="outline" onClick={() => go(buildDateRangeQuery({ range, from, to, defaultRange, keep: keepParams }))}>
        Filtrer
      </Button>
      {isFiltered && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setRange(defaultRange);
            setFrom("");
            setTo("");
            go(buildDateRangeQuery({ range: defaultRange, from: "", to: "", defaultRange, keep: keepParams }));
          }}
        >
          Réinitialiser
        </Button>
      )}
    </div>
  );
}
