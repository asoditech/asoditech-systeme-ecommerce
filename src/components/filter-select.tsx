"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A list-page filter dropdown that navigates on change and shows the
 * chosen label immediately.
 *
 * The server-rendered `<Select name=…>` inside a `<form>` this replaces
 * looked broken: picking an option closed the menu but the trigger kept
 * showing the old label, because a Server Component can only give
 * `<Select.Value>` a *static* child derived from the URL param — which
 * doesn't change until the form is submitted. This is a Client Component,
 * so it drives `<Select.Value>` with the real selected value and pushes
 * the new query string (resetting `page`) as soon as you pick.
 */
const ALL = "__all__";

export function FilterSelect({
  paramKey,
  value,
  options,
  allLabel,
  ariaLabel,
  className,
}: {
  paramKey: string;
  /** Current value from the URL (undefined ⇒ "all"). */
  value?: string;
  options: { value: string; label: string }[];
  /** When set, an extra "all" item is shown that clears the param. */
  allLabel?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function onChange(next: string | null) {
    const sp = new URLSearchParams(searchParams.toString());
    if (!next || next === ALL) sp.delete(paramKey);
    else sp.set(paramKey, next);
    sp.delete("page");
    const qs = sp.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  const labelFor = (v: string) =>
    v === ALL ? (allLabel ?? "Tous") : (options.find((o) => o.value === v)?.label ?? v);

  return (
    <Select value={value ?? ALL} onValueChange={onChange}>
      <SelectTrigger
        aria-label={ariaLabel}
        title={labelFor(value ?? ALL)}
        className={cn(
          isPending && "opacity-60",
          className,
          // Phones: a filter is at least half a row (two side by side) but
          // grows to fit its chosen label — a long one (« Toutes les sources
          // de coût ») takes its own row instead of being cut off.
          "max-sm:w-auto max-sm:max-w-full max-sm:min-w-[calc(50%-0.25rem)] max-sm:grow"
        )}
      >
        <SelectValue>{(v: string) => labelFor(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allLabel ? <SelectItem value={ALL}>{allLabel}</SelectItem> : null}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
