import * as React from "react"

import { cn } from "@/lib/utils"

/** ASODITECH multiline input — matches Input's border / focus / disabled
 * language. See docs/adr/0014-ui-design-system.md. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2.5 text-base shadow-xs transition-[color,box-shadow,border-color] outline-none",
        "placeholder:text-muted-foreground/70",
        "hover:border-ring/45",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-border/60 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        "md:text-sm",
        "dark:bg-input/25 dark:hover:border-ring/50 dark:disabled:bg-input/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
