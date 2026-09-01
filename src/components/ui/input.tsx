import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * ASODITECH text input — see docs/adr/0014-ui-design-system.md.
 * 40px tall, rounded-lg, calm 1px border that warms on hover and lifts to
 * the orange focus ring; a distinct (not just dimmed) disabled state; a
 * red border + ring for `aria-invalid`.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-1 text-base shadow-xs transition-[color,box-shadow,border-color] outline-none",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-muted-foreground/70",
        "hover:border-ring/45",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border/60 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:placeholder:text-muted-foreground/50",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        "md:text-sm",
        "dark:bg-input/25 dark:hover:border-ring/50 dark:disabled:bg-input/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
