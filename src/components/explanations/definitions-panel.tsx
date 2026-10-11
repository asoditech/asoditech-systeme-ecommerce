"use client";

import { ExplanationLanguageToggle, useExplanationLanguage } from "@/components/analytics/explanation-language";
import { ExplanationBody } from "@/components/analytics/metric-explanation";
import { EXPLANATION_UI, type ExplanationDoc } from "@/lib/metrics/analytics-explanations";

/**
 * « Définitions des indicateurs » — the full explanation of every item of a
 * page (définition, calcul, périmètre, période, filtres, exemple,
 * interprétation, précautions, accès) in the explanation language chosen by
 * the viewer. The « ⓘ » popovers link here (`definition-<id>`). Callers pass
 * entries from a CLIENT-SIDE registry lookup (see the per-registry wrappers).
 */
export function DefinitionsPanel({ entries }: { entries: { id: string; doc: ExplanationDoc }[] }) {
  const lang = useExplanationLanguage();
  return (
    <details id="definitions" className="rounded-xl border bg-card p-4 text-sm shadow-card print:hidden">
      <summary className="cursor-pointer font-medium">Définitions des indicateurs</summary>
      <div className="mt-3">
        <ExplanationLanguageToggle />
      </div>
      <dl className="mt-3 space-y-4">
        {entries.map(({ id, doc }) => (
          <div key={id} id={`definition-${id}`} className="scroll-mt-20">
            <dt className="font-medium">{doc.labels.join(" / ")}</dt>
            <dd className="mt-1 text-[13px]">
              <ExplanationBody text={doc.text} lang={lang}>
                <div>
                  <p className="font-medium text-foreground">{EXPLANATION_UI.access[lang]}</p>
                  <p className="text-muted-foreground" dir="ltr">
                    {doc.access}
                  </p>
                </div>
              </ExplanationBody>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
