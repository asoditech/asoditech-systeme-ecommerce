"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollFade } from "@/components/ui/scroll-fade"

/**
 * The scroll container is a `ScrollFade`: when a wide table does not fit,
 * a soft fade marks the hidden edge(s) and the container becomes a
 * focusable, labelled region (arrow keys scroll it) — horizontal scroll is
 * never silent. `scrollLabel` names that region.
 */
function Table({ className, scrollLabel = "Tableau — faire défiler horizontalement", ...props }: React.ComponentProps<"table"> & { scrollLabel?: string }) {
  return (
    <ScrollFade
      data-slot="table-container"
      label={scrollLabel}
      className="relative w-full"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </ScrollFade>
  )
}

/**
 * Soft UI: the white card a list table sits in (24px radius, no border,
 * almost flat shadow). Put the table and its `DataTablePagination` inside.
 */
function TableCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-card"
      className={cn("overflow-hidden rounded-card bg-card shadow-card [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6", className)}
      {...props}
    />
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-hairline font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "group/row border-b border-hairline transition-colors duration-150 hover:bg-row-hover has-aria-expanded:bg-row-hover data-[state=selected]:bg-nav-hover motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-11 px-4 text-left align-middle text-xs font-normal whitespace-nowrap text-ink-muted [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-16 px-4 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-ink-muted", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableCard,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
