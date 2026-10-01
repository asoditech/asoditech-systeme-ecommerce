import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Status pill — see docs/adr/0014-ui-design-system.md. Soft tinted fills
 * (not solid) so a table full of them stays calm: `default` reads as the
 * brand-orange "in progress / active" state, `secondary` neutral, `destructive`
 * red, `outline` a quiet bordered tag.
 *
 * Phase 5 visual QA: semantic `success` (done / paid / validated),
 * `warning` (partial / needs attention) and `info` (in transit / neutral
 * progress) variants — before these, every "good" state rendered brand
 * orange, which on a status pill reads as a warning, not as "done".
 * Light-mode text shades are chosen for WCAG AA on their own tint: the
 * orange pill uses the burnt-orange `accent-foreground` (6.4:1), warning
 * amber-800 (6.6:1), destructive a 25%-darker red (6.3:1).
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5.5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "border-primary/25 bg-primary/12 text-accent-foreground [a]:hover:bg-primary/18 dark:border-primary/25 dark:bg-primary/15 dark:text-primary",
        success:
          "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 [a]:hover:bg-emerald-500/15",
        warning:
          "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-400 [a]:hover:bg-amber-500/15",
        info:
          "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400 [a]:hover:bg-sky-500/15",
        secondary:
          "border-border/70 bg-secondary text-secondary-foreground [a]:hover:bg-secondary/70",
        destructive:
          "border-destructive/25 bg-destructive/10 text-[color-mix(in_oklch,var(--destructive),black_25%)] dark:text-destructive focus-visible:ring-destructive/25 dark:border-destructive/25 dark:bg-destructive/15 [a]:hover:bg-destructive/15",
        outline:
          "border-border text-muted-foreground [a]:hover:bg-muted [a]:hover:text-foreground",
        ghost:
          "border-transparent hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
