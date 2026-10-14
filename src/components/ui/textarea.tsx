import * as React from "react"

import { cn } from "@/lib/utils"

/** ASODITECH multiline input — matches Input's border / focus / disabled
 * language. See docs/adr/0014-ui-design-system.md. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-control border border-field-border bg-field px-4 py-3 text-base text-ink transition-[color,box-shadow,border-color] duration-150 outline-none",
        "placeholder:text-ink-muted",
        "hover:border-field-border-hover",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-field-border disabled:bg-nav-hover disabled:text-ink-muted disabled:shadow-none",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        "md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
