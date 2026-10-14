import Link from "next/link";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Soft UI list-page toolbar: search, selects, date range and period
 * presets on one wrapping row above the table card. Layout only.
 */
export function FilterBar({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mb-5 flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

/** Active-filter chip: a neutral pill that removes the filter when clicked. */
export function FilterChip({
  href,
  label,
  value,
  className,
}: {
  href: string;
  label: string;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full bg-pill-neutral px-3 text-xs text-ink-secondary transition-colors hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
        className
      )}
    >
      {label} <span className="font-medium text-ink">{value}</span>
      <X className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

/**
 * Counter chip for a status strip above a list (« En transit 12 »): white
 * pill, tinted icon, muted label, ink figure. A link when it filters the list.
 */
export function StatChip({
  icon: Icon,
  iconClassName,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  iconClassName?: string;
  label: React.ReactNode;
  value: React.ReactNode;
  href?: string | null;
}) {
  const body = (
    <>
      <Icon className={cn("size-4", iconClassName)} aria-hidden="true" />
      <span className="text-ink-secondary">{label}</span>
      <span className="font-semibold text-ink tabular-nums">{value}</span>
    </>
  );
  const className = "inline-flex h-9 items-center gap-2 rounded-full bg-card px-3.5 text-sm shadow-card";
  return href ? (
    <Link
      href={href}
      className={cn(className, "transition-colors hover:bg-row-hover focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none")}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
