import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * ASODITECH text input — see docs/adr/0014-ui-design-system.md.
 * Soft UI: 44px tall (same as the default Button), 14px radius, a 1px
 * #E8E8E8 edge that darkens on hover, a soft orange focus ring, a filled
 * disabled state and a red border + ring for `aria-invalid`.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-control border border-field-border bg-field px-4 py-1 text-base text-ink transition-[color,box-shadow,border-color] duration-150 outline-none",
        "file:inline-flex file:h-8 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-ink-muted",
        "hover:border-field-border-hover",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-field-border disabled:bg-nav-hover disabled:text-ink-muted disabled:shadow-none disabled:placeholder:text-ink-faint",
        "aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
        "md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Input }
