"use client";

import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { METRIC_GLOSSARY, type MetricKey } from "@/lib/metrics/glossary";

/**
 * « ⓘ » next to a metric label: what it measures, how it is calculated, a
 * worked example (src/lib/metrics/glossary.ts). A real button opening a
 * popover — works with a tap, a click, Enter / Space, and closes with
 * Escape — never a hover-only tooltip.
 */
export function MetricInfo({ metric, className }: { metric: MetricKey; className?: string }) {
  const m = METRIC_GLOSSARY[metric];
  return (
    <Popover>
      <PopoverTrigger
        className={
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring " +
          (className ?? "")
        }
        aria-label={`Comment est calculé « ${m.label} » ?`}
      >
        <Info className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-xs leading-relaxed">
        <p className="text-sm font-semibold">{m.label}</p>
        <p>{m.what}</p>
        <div>
          <p className="font-medium text-foreground">Calcul</p>
          <p className="text-muted-foreground">{m.how}</p>
        </div>
        <div>
          <p className="font-medium text-foreground">Exemple</p>
          <p className="text-muted-foreground">{m.example}</p>
        </div>
        {"limit" in m && m.limit ? <p className="rounded-md bg-muted px-2 py-1.5 text-muted-foreground">À savoir : {m.limit}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
