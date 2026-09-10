import { Info, TriangleAlert, CheckCircle2, OctagonAlert } from "lucide-react";
import type { CalloutTone } from "@/lib/docs/types";

const TONE_STYLES: Record<CalloutTone, { icon: typeof Info; classes: string }> = {
  info: { icon: Info, classes: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-100" },
  warning: {
    icon: TriangleAlert,
    classes: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100",
  },
  success: {
    icon: CheckCircle2,
    classes: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100",
  },
  danger: {
    icon: OctagonAlert,
    classes: "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-100",
  },
};

export function Callout({ tone, title, text }: { tone: CalloutTone; title?: string; text: string }) {
  const { icon: Icon, classes } = TONE_STYLES[tone];
  return (
    <div className={`flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm ${classes}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>
        {title && <p className="mb-0.5 font-medium">{title}</p>}
        <p className="leading-relaxed">{text}</p>
      </div>
    </div>
  );
}
