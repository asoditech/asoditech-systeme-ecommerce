"use client";

import { DefinitionsPanel } from "@/components/explanations/definitions-panel";
import { DASHBOARD_METRICS, DASHBOARD_METRIC_IDS } from "@/lib/metrics/dashboard-explanations";

/** « Définitions des indicateurs » of the dashboard (src/lib/metrics/dashboard-explanations.ts). */
export function DashboardDefinitions() {
  return (
    <div className="mt-6">
      <DefinitionsPanel entries={DASHBOARD_METRIC_IDS.map((id) => ({ id, doc: DASHBOARD_METRICS[id] }))} />
    </div>
  );
}
