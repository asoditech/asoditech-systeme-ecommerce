import type { LucideIcon } from "lucide-react";

/**
 * Phase 3 (Premium Visual SaaS Transformation, section 19) — an
 * intentional-feeling empty state instead of a bare dashed box: the icon
 * sits in a soft tinted circle (same visual grammar as a KpiCard's icon
 * badge) so it reads as designed, not as a missing-content placeholder.
 * `description` is where a caller should say WHY the list is empty and
 * what to do next — never invented here, always the caller's own copy.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
