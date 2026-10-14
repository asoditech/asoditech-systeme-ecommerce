"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-center gap-1 rounded-control p-1 text-ink-secondary group-data-horizontal/tabs:h-11 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        // Soft UI segmented track: the active tab is a white thumb.
        default: "bg-segment-track",
        // Project-wide tab style: a left-aligned underline bar sitting on a
        // hairline border, no filled pill background. Pages that need the
        // pill style pass variant="default" explicitly.
        line: "mb-5 h-auto w-full flex-wrap justify-start gap-1 border-b border-hairline bg-transparent p-0 group-data-horizontal/tabs:h-auto",
      },
    },
    defaultVariants: {
      variant: "line",
    },
  }
)

function TabsList({
  className,
  variant = "line",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-transparent px-3.5 py-1 text-sm font-medium whitespace-nowrap text-ink-secondary transition-[color,background-color,box-shadow] duration-150 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // "line" variant — an underline indicator instead of a filled pill;
        // the list is h-auto here, so the trigger sizes from its own padding.
        "group-data-[variant=line]/tabs-list:h-10 group-data-[variant=line]/tabs-list:flex-none group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-transparent group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:px-3 group-data-[variant=line]/tabs-list:data-active:bg-transparent group-data-[variant=line]/tabs-list:data-active:text-ink",
        // "default" variant — Soft UI segmented control: the active tab is a
        // white thumb with a soft shadow on the grey track (neutral, never
        // orange — the orange is kept for the primary action).
        "data-active:group-data-[variant=default]/tabs-list:bg-segment-thumb data-active:group-data-[variant=default]/tabs-list:text-ink data-active:group-data-[variant=default]/tabs-list:shadow-soft",
        // "line" variant indicator: a neutral ink bar under the active tab.
        "after:absolute after:bg-ink after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-horizontal/tabs:after:rounded-full group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100 group-data-[variant=line]/tabs-list:after:bottom-[-1px]",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
