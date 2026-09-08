"use client";

import { useRef, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Text search for a list page. Submits on Enter or blur, merging the term
 * into the existing query string and resetting `page` — companion to
 * `FilterSelect` so a filter bar is fully client-driven and consistent.
 *
 * Uncontrolled: the input's `key` is the URL's current value, so it
 * remounts (picking up the fresh `defaultValue`) whenever the param
 * changes elsewhere — e.g. "Réinitialiser" — without a state-in-effect.
 */
export function FilterSearchInput({
  paramKey = "q",
  placeholder,
  defaultValue,
  className,
}: {
  paramKey?: string;
  placeholder?: string;
  defaultValue?: string;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  const committed = searchParams.get(paramKey) ?? defaultValue ?? "";

  function submit() {
    const next = (ref.current?.value ?? "").trim();
    if (next === committed) return;
    const sp = new URLSearchParams(searchParams.toString());
    if (next) sp.set(paramKey, next);
    else sp.delete(paramKey);
    sp.delete("page");
    const qs = sp.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        key={committed}
        ref={ref}
        defaultValue={committed}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        onBlur={submit}
        className={cn("pl-8", isPending && "opacity-60")}
      />
    </div>
  );
}
