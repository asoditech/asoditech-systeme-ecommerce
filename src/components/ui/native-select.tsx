import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Phase 5 visual QA — a styled native `<select>`: same height, radius,
 * border, focus ring and disabled/invalid states as `Input`/`SelectTrigger`,
 * with the browser's default arrow replaced by the app's chevron. For the
 * form selects that stay native on purpose (plain `value`/`onChange` or
 * `name`/`defaultValue` form posting, OS picker on mobile) — use the Base UI
 * `Select` when a searchable or rich option list is needed instead.
 */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div data-slot="native-select-wrapper" className="relative w-full">
      <select
        data-slot="native-select"
        className={cn(
          "h-11 w-full min-w-0 cursor-pointer appearance-none rounded-control border border-field-border bg-field py-1 pr-10 pl-4 text-sm text-ink transition-[color,box-shadow,border-color] duration-150 outline-none dark:[color-scheme:dark]",
          "hover:border-field-border-hover",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-field-border disabled:bg-nav-hover disabled:text-ink-muted disabled:shadow-none",
          "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 text-ink-muted"
      />
    </div>
  )
}

export { NativeSelect }
