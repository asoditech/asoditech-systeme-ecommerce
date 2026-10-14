import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Soft UI callout — the ONE inline message box (warning, error, success,
 * info, neutral hint). A pastel fill with darker same-hue text (the pill
 * tokens, AA in light and dark), 16px radius, no border. Replaces the
 * scattered `border-amber-500/30 bg-amber-500/10 …` boxes. Pass `role`
 * (e.g. "alert") through as usual; a leading lucide icon is sized for you.
 */
const noticeVariants = cva(
  "flex items-start gap-2 rounded-tile px-3.5 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        warning: "bg-pill-yellow text-pill-yellow-fg",
        danger: "bg-pill-red text-pill-red-fg",
        success: "bg-pill-green text-pill-green-fg",
        info: "bg-pill-blue text-pill-blue-fg",
        neutral: "bg-pill-neutral text-ink-secondary",
        /** A hint with no state: dashed hairline, muted text. */
        hint: "border border-dashed border-field-border text-ink-muted",
      },
      size: {
        default: "",
        sm: "px-3 py-2 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "default" },
  }
)

function Notice({
  className,
  tone,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof noticeVariants>) {
  return <div data-slot="notice" className={cn(noticeVariants({ tone, size }), className)} {...props} />
}

export { Notice, noticeVariants }
