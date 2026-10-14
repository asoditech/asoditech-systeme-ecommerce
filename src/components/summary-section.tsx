import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A named section of a dashboard-style page. Groups related cards under a
 * small heading (Aperçu / Ventes & commandes / Stock / …) instead of one
 * long undifferentiated grid of identical tiles, so the page reads as a
 * composed dashboard rather than a stat dump. Purely a layout/heading
 * wrapper — never fetches or shapes data itself.
 *
 * Phase 4 (Complete Product UI/UX Visual Redesign) — the section icon now
 * sits in a small tinted badge instead of floating bare next to the label:
 * a section header should have the same visual grammar as everything else
 * in the redesigned system (KpiCard, HighlightKpi, CommandHero all use a
 * tinted icon badge), not be the one remaining plain/undecorated element.
 */
export function SummarySection({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2.5 text-base font-semibold text-ink">
          {Icon && (
            <span className="flex size-7 items-center justify-center rounded-lg bg-nav-active text-ink-secondary">
              <Icon className="size-3.5" />
            </span>
          )}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
