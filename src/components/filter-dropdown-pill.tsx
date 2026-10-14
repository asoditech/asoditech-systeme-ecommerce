"use client";

import Link from "next/link";
import { CheckIcon, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Soft UI « dropdown pill » (e.g. « Ce mois » ⌄ in a card header): a white
 * pill showing the current choice, opening a menu of the other choices.
 * Every choice is a real link — the same URL-driven, server-rendered filter
 * a SegmentedControl would be, just more compact.
 */
export function FilterDropdownPill({
  ariaLabel,
  items,
  align = "end",
  className,
}: {
  /** What the pill filters, e.g. « Période » — read before the current choice. */
  ariaLabel: string;
  items: { key: string; label: string; href: string; active: boolean }[];
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const current = items.find((i) => i.active) ?? items[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className={cn("rounded-full pr-3 pl-4", className)} aria-label={`${ariaLabel} : ${current?.label ?? ""}`} />}
      >
        {current?.label}
        <ChevronDown data-icon="inline-end" className="text-ink-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-auto min-w-44">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.key}
            render={<Link href={item.href} aria-current={item.active ? "true" : undefined} />}
            className={cn("justify-between gap-4", item.active && "font-medium text-ink")}
          >
            {item.label}
            {item.active && <CheckIcon className="text-ink" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
