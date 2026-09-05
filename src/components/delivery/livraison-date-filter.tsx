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
}: {
  initialRange: DateRangePreset;
  initialFrom?: string;
  initialTo?: string;
}) {
  const router = useRouter();
  const [range, setRange] = useState<DateRangePreset>(initialRange);
  const [from, setFrom] = useState(initialFrom ?? "");
  const [to, setTo] = useState(initialTo ?? "");

  const isFiltered = range !== "all" || Boolean(from || to);

  function apply() {
    const params = new URLSearchParams();
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
    <div className="mb-4 flex flex-wrap items-center gap-2">
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
            setRange("all");
            setFrom("");
            setTo("");
            router.push("/livraison");
          }}
        >
          Réinitialiser
        </Button>
      )}
    </div>
  );
}
