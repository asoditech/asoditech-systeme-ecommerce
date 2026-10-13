import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        // Soft UI: white, 24px radius, no border, an almost flat shadow.
        // `--card-spacing` is the ONE padding lever: 20px by default, 16px
        // for "sm" (a tight tile, e.g. a KPI grid).
        "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-card bg-card py-(--card-spacing) text-sm text-card-foreground shadow-card [--card-spacing:--spacing(5)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-card *:[img:last-child]:rounded-b-card",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-card px-(--card-spacing) [.border-b]:border-hairline has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

const CARD_ACCENTS = {
  green: "bg-pastel-green",
  blue: "bg-pastel-blue",
  purple: "bg-pastel-purple",
  peach: "bg-pastel-peach",
  yellow: "bg-pastel-yellow",
} as const

/** `accent` (optional): the small pastel vertical bar (6×24) before the
 * title — one colour per card type. */
function CardTitle({
  className,
  accent,
  children,
  ...props
}: React.ComponentProps<"div"> & { accent?: keyof typeof CARD_ACCENTS }) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-lg leading-snug font-semibold text-ink group-data-[size=sm]/card:text-[15px]",
        accent && "flex items-center gap-3",
        className
      )}
      {...props}
    >
      {accent && <span aria-hidden="true" data-slot="card-accent" className={cn("h-6 w-1.5 shrink-0 rounded-full", CARD_ACCENTS[accent])} />}
      {children}
    </div>
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-ink-secondary", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-card border-t border-hairline p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
