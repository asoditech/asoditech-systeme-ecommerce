"use client";

import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ExplanationLanguageToggle, useExplanationLanguage } from "@/components/analytics/explanation-language";
import { ExplanationBody } from "@/components/analytics/metric-explanation";
import { EXPLANATION_UI, SECTION_TITLES, type ExplanationLang, type MetricText } from "@/lib/metrics/analytics-explanations";

/** Opens the page's « Définitions » panel (details#definitions) and scrolls to the item. */
function openDefinition(anchor: string) {
  const panel = document.getElementById("definitions");
  if (panel instanceof HTMLDetailsElement) panel.open = true;
  document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/**
 * « ⓘ » next to a figure or a setting — any registry. A real button opening
 * a popover (tap, click, Enter / Space, Escape) with the explanation, the
 * Français / العربية switch and, when the page has a « Définitions » panel,
 * a link to the full explanation. `compact` (default) = définition, calcul,
 * exemple; settings pass `compact={false}` (short texts, no panel).
 */
export function ExplanationInfo({
  label,
  text,
  detailsAnchor,
  compact = true,
  titles,
  className,
}: {
  label: string;
  text: Record<ExplanationLang, MetricText>;
  /** id of the item in the page's details#definitions panel. */
  detailsAnchor?: string;
  compact?: boolean;
  /** Section headings override (see ExplanationBody). */
  titles?: Partial<typeof SECTION_TITLES>;
  className?: string;
}) {
  const lang = useExplanationLanguage();
  return (
    <Popover>
      <PopoverTrigger
        className={
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring " +
          (className ?? "")
        }
        aria-label={EXPLANATION_UI.howComputed.fr(label)}
      >
        <Info className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] space-y-2 overflow-y-auto text-xs leading-relaxed">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">{label}</p>
          <ExplanationLanguageToggle />
        </div>
        <ExplanationBody text={text} lang={lang} compact={compact} titles={titles}>
          {detailsAnchor && (
            <a href={`#${detailsAnchor}`} onClick={() => openDefinition(detailsAnchor)} className="block pt-1 text-primary hover:underline">
              {EXPLANATION_UI.fullDetails[lang]}
            </a>
          )}
        </ExplanationBody>
      </PopoverContent>
    </Popover>
  );
}
