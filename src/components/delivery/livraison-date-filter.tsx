"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";

/**
 * The Livraison "période" filter. Client-side so the trigger shows the
 * chosen label immediately and the custom date fields only appear when
 * "Période personnalisée" is selected — neither of which a server-
 * rendered <form> can do before a submit.
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
  const router = useRouter();
  const [range, setRange] = useState<DateRangePreset>(initialRange);
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  const isFiltered = range !== "all" || Boolean(from || to);

  function baseParams() {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(keepParams ?? {})) if (value) params.set(key, value);
    return params;
  }

  function apply() {
    const params = baseParams();
    if (range === "custom") {
      if (from) params.set("dateFrom", from);
      if (to) params.set("dateTo", to);
      params.set("range", "custom");
    } else if (range !== "all") {
      params.set("range", range);
    }
    const qs = params.toString();
    router.push(qs ? `/livraison?${qs}` : "/livraison");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted-foreground" title="Date à laquelle l'expédition a été créée — pas la date de la commande.">
        Expéditions créées
      </label>
      <Select value={range} onValueChange={(v) => v && setRange(v as DateRangePreset)}>
        <SelectTrigger className="w-52" aria-label="Période de création des expéditions">
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
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" aria-label="Expéditions créées à partir du" />
          <label className="ml-1 text-xs text-muted-foreground">Au</label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="Expéditions créées jusqu'au" />
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
            setRange("all");
            setFrom("");
            setTo("");
            const qs = baseParams().toString();
            router.push(qs ? `/livraison?${qs}` : "/livraison");
          }}
        >
          Réinitialiser
        </Button>
      )}
    </div>
  );
}
