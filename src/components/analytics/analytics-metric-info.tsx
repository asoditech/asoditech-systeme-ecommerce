"use client";

import { ExplanationInfo } from "@/components/explanations/explanation-info";
import { ANALYTICS_METRICS, type AnalyticsMetricId } from "@/lib/metrics/analytics-explanations";

/**
 * « ⓘ » on an /analyses figure (src/lib/metrics/analytics-explanations.ts):
 * compact explanation, Français / العربية switch, link to the full text in
 * « Définitions des indicateurs ». The label stays as displayed on the card.
 */
export function AnalyticsMetricInfo({ metric, label, className }: { metric: AnalyticsMetricId; label?: string; className?: string }) {
  return (
    <ExplanationInfo
      label={label ?? ANALYTICS_METRICS[metric].labels[0]}
      text={ANALYTICS_METRICS[metric].text}
      detailsAnchor={`definition-${metric}`}
      className={className}
    />
  );
}
