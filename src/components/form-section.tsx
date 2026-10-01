import { cn } from "@/lib/utils";

/**
 * A named group of related fields inside a form — Phase 2 UI refinement
 * ("modern SaaS forms group related fields instead of one flat list", see
 * docs/adr/0014-ui-design-system.md). Purely presentational: renders its
 * own eyebrow title + optional description, then whatever fields/`Field`/
 * `FieldRow` (src/components/ui/field.tsx) the caller passes as children.
 * Meant for forms with genuinely distinct groups (identity / contact /
 * address / notes) — a 2-3 field form doesn't need this at all, plain
 * `<Field>`s are enough.
 */
export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <div className="space-y-0.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {description && <p className="text-xs text-muted-foreground/80">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** Stacks several `FormSection`s with a consistent divider rhythm between them. */
export function FormSectionGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("space-y-5 [&>*+*]:border-t [&>*+*]:border-border/60 [&>*+*]:pt-5", className)}>{children}</div>;
}

/**
 * Phase 5 visual QA — a form's action area as a deliberate surface, not an
 * afterthought row of buttons: a sticky bar (it stays in reach on a long
 * form, pinned just above the fixed site footer) with optional context on
 * the left (a total, a "stock is only added on validation" reminder) and
 * the action hierarchy on the right — secondary (Annuler) then the one
 * primary action last, where the eye ends.
 */
export function FormActions({
  children,
  context,
  className,
}: {
  children: React.ReactNode;
  context?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "sticky bottom-11 z-20 flex flex-col gap-3 rounded-xl bg-card/95 px-4 py-3 shadow-popover ring-1 ring-border backdrop-blur supports-backdrop-filter:bg-card/85 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
    >
      <div className="min-w-0 text-sm text-muted-foreground">{context}</div>
      <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}
