"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { GuidedTour } from "@/lib/docs/types";

/**
 * A guided-demo stepper — purely navigational ("Essayer maintenant" deep
 * links to the real page). Never automates or mutates anything itself.
 */
export function GuidedTourViewer({ tour }: { tour: GuidedTour }) {
  const [current, setCurrent] = useState(0);
  const [done, setDone] = useState<Set<number>>(new Set());

  function markDone(i: number) {
    setDone((prev) => new Set(prev).add(i));
    if (i < tour.steps.length - 1) setCurrent(i + 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        {tour.steps.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full ${done.has(i) ? "bg-brand" : i === current ? "bg-brand/40" : "bg-chart-track"}`}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Étape {current + 1} / {tour.steps.length}
      </p>
      <div className="space-y-3">
        {tour.steps.map((step, i) => (
          <div
            key={i}
            className={`rounded-tile border p-3.5 ${i === current ? "border-brand/60 bg-pill-peach/30" : "border-hairline opacity-70"}`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  done.has(i) ? "bg-brand text-brand-foreground" : "bg-pill-neutral text-ink-secondary"
                }`}
              >
                {done.has(i) ? <Check className="size-3" /> : i + 1}
              </span>
              <p className="text-sm font-medium">{step.label}</p>
            </div>
            <p className="mt-1.5 pl-7 text-sm text-muted-foreground">{step.description}</p>
            {i === current && (
              <div className="mt-2.5 flex items-center gap-2 pl-7">
                {step.href && (
                  <Button size="sm" variant="outline" render={<Link href={step.href} target="_blank" />}>
                    Essayer maintenant
                    <ArrowRight className="size-3.5" />
                  </Button>
                )}
                <Button size="sm" onClick={() => markDone(i)}>
                  {i < tour.steps.length - 1 ? "Étape suivante" : "Terminer"}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
