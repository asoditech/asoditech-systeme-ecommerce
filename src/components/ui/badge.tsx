import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Status pill — see docs/adr/0014-ui-design-system.md. Soft UI: a pastel
 * fill with darker same-hue text (all ≥ 5.7:1, light and dark), 999px
 * radius, 12px / 500, no border. Semantic intents map onto the pastel
 * palette: default = peach (in progress), success = green, warning =
 * yellow (pending / needs attention), info = blue, purple = a further
 * neutral-progress hue, secondary = neutral grey, destructive = red tint,
 * outline = a quiet bordered tag.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/25 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-pill-peach text-pill-peach-fg [a]:hover:brightness-95",
        success: "bg-pill-green text-pill-green-fg [a]:hover:brightness-95",
        warning: "bg-pill-yellow text-pill-yellow-fg [a]:hover:brightness-95",
        info: "bg-pill-blue text-pill-blue-fg [a]:hover:brightness-95",
        purple: "bg-pill-purple text-pill-purple-fg [a]:hover:brightness-95",
        secondary: "bg-pill-neutral text-pill-neutral-fg [a]:hover:brightness-95",
        destructive: "bg-pill-red text-pill-red-fg focus-visible:ring-destructive/25 [a]:hover:brightness-95",
        outline:
          "border-field-border text-ink-secondary [a]:hover:bg-nav-hover [a]:hover:text-ink",
        ghost:
          "hover:bg-nav-hover hover:text-ink-secondary",
        link: "text-ink underline-offset-4 hover:underline",
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
