import { Info, TriangleAlert, CheckCircle2, OctagonAlert } from "lucide-react";
import type { CalloutTone } from "@/lib/docs/types";
import { Notice } from "@/components/ui/notice";

// Soft UI: the docs callout is the shared `Notice` (pastel fill, AA text in both themes).
const TONE_ICONS: Record<CalloutTone, typeof Info> = {
  info: Info,
  warning: TriangleAlert,
  success: CheckCircle2,
  danger: OctagonAlert,
};

export function Callout({ tone, title, text }: { tone: CalloutTone; title?: string; text: string }) {
  const Icon = TONE_ICONS[tone];
  return (
    <Notice tone={tone} className="gap-2.5 px-3.5 py-3">
      <Icon />
      <div>
        {title && <p className="mb-0.5 font-medium">{title}</p>}
        <p className="leading-relaxed">{text}</p>
      </div>
    </Notice>
  );
}
