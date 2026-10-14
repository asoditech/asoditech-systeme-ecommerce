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
