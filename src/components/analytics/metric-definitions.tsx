import { METRIC_DEFINITIONS } from "@/lib/analytics/definitions";
import type { AnalyticsSection } from "@/lib/analytics/access";

/** « Définitions » — population, date, formula, exclusions and permission of each figure on the page. */
export function MetricDefinitions({ section }: { section: AnalyticsSection }) {
  return (
    <details className="rounded-xl border bg-card p-4 text-sm shadow-card print:hidden">
      <summary className="cursor-pointer font-medium">Définitions des indicateurs</summary>
      <dl className="mt-3 space-y-3">
        {METRIC_DEFINITIONS[section].map((d) => (
          <div key={d.name}>
            <dt className="font-medium">{d.name}</dt>
            <dd className="text-muted-foreground">
              <span className="block">Population : {d.population}</span>
              <span className="block">Date : {d.date}</span>
              <span className="block">Calcul : {d.formula}</span>
              {d.exclusions && <span className="block">Exclusions : {d.exclusions}</span>}
              <span className="block">Accès : {d.permission}</span>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
