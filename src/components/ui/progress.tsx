import { cn } from "@/lib/utils"

/**
 * Hand-built (no @base-ui/react primitive for this, same reasoning as
 * checkbox/switch/popover/tooltip — docs/adr/0001-tech-stack.md): a plain
 * div-based bar is all a determinate progress indicator needs. `value` is
 * clamped to [0, 100] for the bar width itself — a caller showing "142%"
 * as text can still pass a raw percent for the label while the bar caps
 * visually at full.
 */
function Progress({
  value,
  className,
  indicatorClassName,
  ...props
}: React.ComponentProps<"div"> & { value: number; indicatorClassName?: string }) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn("h-full rounded-full bg-primary transition-[width]", indicatorClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}

export { Progress }
