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
          "h-9 w-full min-w-0 cursor-pointer appearance-none rounded-lg border border-input bg-card py-1 pr-9 pl-3 text-sm shadow-xs transition-[color,box-shadow,border-color] outline-none",
          "hover:border-ring/45",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border/60 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
          "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
          "dark:bg-input/25 dark:hover:border-ring/50",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  )
}

export { NativeSelect }
