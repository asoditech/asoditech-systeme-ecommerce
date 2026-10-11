"use client";

import type { AnalyticsSection } from "@/lib/analytics/access";
import { DefinitionsPanel } from "@/components/explanations/definitions-panel";
import { ANALYTICS_METRICS, metricsForSection } from "@/lib/metrics/analytics-explanations";

/** « Définitions des indicateurs » of an /analyses tab (src/lib/metrics/analytics-explanations.ts). */
export function MetricDefinitions({ section }: { section: AnalyticsSection }) {
  return <DefinitionsPanel entries={metricsForSection(section).map((id) => ({ id, doc: ANALYTICS_METRICS[id] }))} />;
}
