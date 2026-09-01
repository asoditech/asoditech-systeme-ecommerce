import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Form-field composition helpers — a consistent vertical rhythm for
 * label → control → hint/error, and matching typography for hint and
 * validation text. Optional: a plain `<div className="space-y-2">` works
 * too, but `<Field>` keeps every form on the same spacing.
 * See docs/adr/0014-ui-design-system.md.
 *
 *   <Field>
 *     <Label htmlFor="email" required>E-mail</Label>
 *     <Input id="email" name="email" aria-invalid={!!error} />
 *     <FieldError>{error}</FieldError>
 *   </Field>
 */
function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field" className={cn("space-y-2", className)} {...props} />
}

/** A row of fields on one line at ≥sm (e.g. first name / last name). */
function FieldRow({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-row"
      className={cn("grid gap-4 sm:grid-cols-2", className)}
      {...props}
    />
  )
}

function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-hint"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Renders nothing when there's no message, so callers can pass a possibly
 * undefined error straight through. */
function FieldError({
  children,
  className,
  ...props
}: React.ComponentProps<"p">) {
  if (!children) return null
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn("text-xs font-medium text-destructive", className)}
      {...props}
    >
      {children}
    </p>
  )
}

export { Field, FieldRow, FieldHint, FieldError }
