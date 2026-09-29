import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A named section of a dashboard-style page — Phase 2 UI refinement.
 * Groups related cards under a small heading (Aperçu / Ventes & commandes /
 * Stock / …) instead of one long undifferentiated grid of identical tiles,
 * so the page reads as a composed dashboard rather than a stat dump.
 * Purely a layout/heading wrapper — never fetches or shapes data itself.
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
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase">
          {Icon && <Icon className="size-3.5" />}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
