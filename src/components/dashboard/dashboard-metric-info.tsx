"use client";

import { ExplanationInfo } from "@/components/explanations/explanation-info";
import { DASHBOARD_METRICS, type DashboardMetricId } from "@/lib/metrics/dashboard-explanations";

/**
 * « ⓘ » on a dashboard figure (src/lib/metrics/dashboard-explanations.ts):
 * compact explanation, Français / العربية switch, link to the full text in
 * the page's « Définitions des indicateurs ». The label stays as displayed.
 */
export function DashboardMetricInfo({ metric, label, className }: { metric: DashboardMetricId; label?: string; className?: string }) {
  return (
    <ExplanationInfo
      label={label ?? DASHBOARD_METRICS[metric].labels[0]}
      text={DASHBOARD_METRICS[metric].text}
      detailsAnchor={`definition-${metric}`}
      className={className}
    />
  );
}
