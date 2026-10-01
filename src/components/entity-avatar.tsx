import { cn } from "@/lib/utils";

/**
 * Phase 5 visual QA — a compact initials avatar for a business object that
 * has a name but no image (a supplier, a customer, a location). Gives a
 * table row a recognisable "identity" anchor at the far left. Neutral by
 * design: one soft brand tint for every entity — color here is NOT data,
 * so it must not vary per row and imply a meaning it doesn't have.
 */
export function EntityAvatar({ name, className }: { name: string; className?: string }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-[11px] font-semibold text-accent-foreground ring-1 ring-primary/15",
        className
      )}
    >
      {initials}
    </span>
  );
}
