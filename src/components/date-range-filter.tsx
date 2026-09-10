"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";

/**
 * A generic "période" filter (Aujourd'hui/Hier/Ce mois/…/Personnalisée) —
 * same query-string convention (`range`, `dateFrom`, `dateTo`) as
 * `LivraisonDateFilter`, generalized with a `basePath` prop so other pages
 * can reuse it without touching the delivery-specific one.
 */
export function DateRangeFilter({
  basePath,
  initialRange,
  initialFrom,
  initialTo,
  defaultRange = "all",
}: {
  basePath: string;
  initialRange: DateRangePreset;
  initialFrom?: string;
  initialTo?: string;
  defaultRange?: DateRangePreset;
}) {
  const router = useRouter();
  const [range, setRange] = useState<DateRangePreset>(initialRange);
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  const isFiltered = range !== defaultRange || Boolean(from || to);

  function apply() {
    const params = new URLSearchParams();
    if (range === "custom") {
      if (from) params.set("dateFrom", from);
      if (to) params.set("dateTo", to);
      params.set("range", "custom");
    } else if (range !== defaultRange) {
      params.set("range", range);
    }
    const qs = params.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted-foreground">Période</label>
      <Select value={range} onValueChange={(v) => v && setRange(v as DateRangePreset)}>
        <SelectTrigger className="w-52">
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
        <>
          <label className="ml-1 text-xs text-muted-foreground">Du</label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          <label className="ml-1 text-xs text-muted-foreground">Au</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </>
      )}

      <Button type="button" variant="outline" onClick={apply}>
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
            router.push(basePath);
          }}
        >
          Réinitialiser
        </Button>
      )}
    </div>
  );
}
