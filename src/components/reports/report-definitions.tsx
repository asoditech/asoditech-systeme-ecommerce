"use client";

import { DefinitionsPanel } from "@/components/explanations/definitions-panel";
import { REPORT_METRICS, metricsForReport, type ReportId, type ReportMetricId } from "@/lib/metrics/report-explanations";

/** « Définitions des indicateurs » of a /rapports page (src/lib/metrics/report-explanations.ts). */
export function ReportDefinitions({ report, exclude = [] }: { report: ReportId; exclude?: ReportMetricId[] }) {
  const entries = metricsForReport(report).filter((id) => !exclude.includes(id));
  return (
    <div className="mt-6">
      <DefinitionsPanel entries={entries.map((id) => ({ id, doc: REPORT_METRICS[id] }))} />
    </div>
  );
}
