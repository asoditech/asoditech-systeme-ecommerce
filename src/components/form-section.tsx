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
