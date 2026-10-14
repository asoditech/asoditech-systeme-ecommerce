import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * ASODITECH button system — see docs/adr/0014-ui-design-system.md.
 * Soft UI (redesign/soft-ui): 44px controls with the 14px control radius,
 * a soft orange focus ring, icon-only sizes are round. Intents: default =
 * THE orange primary action (text colour = the single `--brand-foreground`
 * token), secondary = soft neutral fill, outline = white pill with a hairline
 * border (the everyday secondary action), ghost = quiet, destructive = solid
 * red, link. Pass `loading` for an inline spinner + disabled state.
 */
const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 items-center justify-center rounded-control border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,box-shadow,border-color,color,transform] duration-150 outline-none select-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 active:not-aria-[haspopup]:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/25 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-brand text-brand-foreground shadow-soft hover:bg-brand-hover",
        secondary:
          "bg-nav-active text-ink hover:bg-[color-mix(in_oklab,var(--nav-active),var(--text-primary)_6%)] aria-expanded:bg-[color-mix(in_oklab,var(--nav-active),var(--text-primary)_6%)]",
        outline:
          "border-field-border bg-shell text-ink shadow-soft hover:border-field-border-hover hover:bg-nav-hover aria-expanded:border-field-border-hover aria-expanded:bg-nav-hover dark:bg-card",
        ghost:
          "text-ink-secondary hover:bg-nav-hover hover:text-ink aria-expanded:bg-nav-hover aria-expanded:text-ink",
        destructive:
          "bg-danger-strong text-white shadow-soft hover:bg-[color-mix(in_oklab,var(--danger-strong),black_10%)] focus-visible:border-danger focus-visible:ring-danger/30",
        link: "text-ink underline underline-offset-4 decoration-ink-faint hover:decoration-ink",
      },
      size: {
        default:
          "h-11 gap-2 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        xs: "h-7 gap-1 rounded-lg px-2.5 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-9 gap-1.5 rounded-xl px-3.5 text-[13px] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-12 gap-2 rounded-2xl px-6 text-[15px] has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5",
        icon: "size-11 rounded-full",
        "icon-xs": "size-7 rounded-full in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-9 rounded-full in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-12 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  children,
  render,
  nativeButton,
  ...props
}: ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & { loading?: boolean }) {
  // `render` is used throughout this app to compose Button with next/link
  // (e.g. `<Button render={<Link href="..." />}>`). Base UI's Button
  // defaults nativeButton to true and warns when the rendered element isn't
  // a real <button> — default it to false whenever `render` swaps the
  // element, but let an explicit nativeButton prop still win.
  const resolvedNativeButton = nativeButton ?? !render;
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading || undefined}
      render={render}
      nativeButton={resolvedNativeButton}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading && (
        <Loader2Icon data-icon="inline-start" className="animate-spin" aria-hidden="true" />
      )}
      {children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
