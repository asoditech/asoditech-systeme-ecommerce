"use client";

import { ExplanationInfo } from "@/components/explanations/explanation-info";
import { REPORT_METRICS, type ReportMetricId } from "@/lib/metrics/report-explanations";

/**
 * « ⓘ » on a /rapports figure (src/lib/metrics/report-explanations.ts):
 * compact explanation, Français / العربية switch, link to the full text in
 * the page's « Définitions des indicateurs ». The label stays as displayed.
 */
export function ReportMetricInfo({ metric, label, className }: { metric: ReportMetricId; label?: string; className?: string }) {
  return (
    <ExplanationInfo
      label={label ?? REPORT_METRICS[metric].labels[0]}
      text={REPORT_METRICS[metric].text}
      detailsAnchor={`definition-${metric}`}
      className={className}
    />
  );
}
