import {
  ANALYTICS_METRICS,
  SECTION_ORDER,
  SECTION_TITLES,
  type AnalyticsMetricId,
  type ExplanationLang,
  type MetricText,
} from "@/lib/metrics/analytics-explanations";
import { cn } from "@/lib/utils";

const COMPACT: (keyof MetricText)[] = ["definition", "calculation", "example"];

/**
 * The explanatory text of one item in one language — any registry
 * (/analyses, /rapports, /parametres). Arabic is wrapped in
 * `lang="ar" dir="rtl"` HERE only — never the label, the value or the page.
 * `compact` = the popover (définition, calcul, exemple); otherwise every
 * section the item has, in the standard order.
 */
export function ExplanationBody({
  text,
  lang,
  compact = false,
  titles,
  className,
  children,
}: {
  text: Record<ExplanationLang, MetricText>;
  /** Section headings override (settings: « Effet » instead of « Calcul », …). */
  titles?: Partial<typeof SECTION_TITLES>;
  lang: ExplanationLang;
  compact?: boolean;
  className?: string;
  /** Extra explanatory content rendered inside the same language wrapper. */
  children?: React.ReactNode;
}) {
  const t = text[lang];
  const sections = (compact ? COMPACT : SECTION_ORDER).filter((k) => t[k]);
  return (
    <div lang={lang === "ar" ? "ar" : undefined} dir={lang === "ar" ? "rtl" : undefined} data-explanation-lang={lang} className={cn("space-y-1.5", lang === "ar" && "text-right", className)}>
      {sections.map((k) => (
        <div key={k}>
          <p className="font-medium text-foreground">{(titles?.[k] ?? SECTION_TITLES[k])[lang]}</p>
          <p className="text-muted-foreground">{t[k]}</p>
        </div>
      ))}
      {children}
    </div>
  );
}

/** An /analyses figure's explanation (src/lib/metrics/analytics-explanations.ts). */
export function MetricExplanationBody({
  metric,
  ...rest
}: {
  metric: AnalyticsMetricId;
  lang: ExplanationLang;
  compact?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return <ExplanationBody text={ANALYTICS_METRICS[metric].text} {...rest} />;
}
