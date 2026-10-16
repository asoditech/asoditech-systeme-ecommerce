"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
/**
 * The list URL for a new search term: the term merged into the current query
 * string (removed when empty), `page` reset. Pure, for the input and tests.
 */
export function searchTermHref(pathname: string, currentQuery: string, paramKey: string, term: string): string {
  const sp = new URLSearchParams(currentQuery);
  const next = term.trim();
  if (next) sp.set(paramKey, next);
  else sp.delete(paramKey);
  sp.delete("page");
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

type FilterSearchInputProps = {
  paramKey?: string;
  placeholder?: string;
  defaultValue?: string;
  className?: string;
  /** Accessible name — a placeholder alone isn't one. */
  ariaLabel?: string;
  /**
   * Opt-in « search as you type »: the URL is updated (history replace)
   * this many ms after the last keystroke, once the term is empty or at
   * least `liveMinChars` long. Enter still applies immediately.
   */
  liveDebounceMs?: number;
  liveMinChars?: number;
};

export function FilterSearchInput(props: FilterSearchInputProps) {
  return props.liveDebounceMs ? <LiveFilterSearchInput {...props} liveDebounceMs={props.liveDebounceMs} /> : <SubmitFilterSearchInput {...props} />;
}

function SubmitFilterSearchInput({ paramKey = "q", placeholder, defaultValue, className, ariaLabel }: FilterSearchInputProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLInputElement>(null);

  const committed = searchParams.get(paramKey) ?? defaultValue ?? "";

  function submit() {
    const next = (ref.current?.value ?? "").trim();
    if (next === committed) return;
    startTransition(() => router.push(searchTermHref(pathname, searchParams.toString(), paramKey, next)));
  }

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        key={committed}
        ref={ref}
        defaultValue={committed}
        placeholder={placeholder}
        aria-label={ariaLabel}
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

/**
 * Live variant: controlled, so the field keeps focus and its text while the
 * URL follows the typing. An outside change of the param (« Réinitialiser »,
 * back button) that is not the term this input applied resets the field.
 */
function LiveFilterSearchInput({
  paramKey = "q",
  placeholder,
  defaultValue,
  className,
  ariaLabel,
  liveDebounceMs,
  liveMinChars = 2,
}: FilterSearchInputProps & { liveDebounceMs: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const committed = searchParams.get(paramKey) ?? defaultValue ?? "";
  const [value, setValue] = useState(committed);
  const [applied, setApplied] = useState(committed);
  const [seenCommitted, setSeenCommitted] = useState(committed);
  // URL changed elsewhere: adopt it (adjusting state during render, not in an
  // effect). Not while our own navigation is in flight — an intermediate URL
  // would otherwise overwrite what is being typed.
  if (committed !== seenCommitted && !isPending) {
    setSeenCommitted(committed);
    if (committed !== applied) {
      setValue(committed);
      setApplied(committed);
    }
  }

  function apply(term: string, mode: "push" | "replace") {
    const next = term.trim();
    if (next === committed.trim()) return;
    setApplied(next);
    const href = searchTermHref(pathname, searchParams.toString(), paramKey, next);
    startTransition(() => (mode === "push" ? router.push(href, { scroll: false }) : router.replace(href, { scroll: false })));
  }

  // Debounced apply while typing.
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });
  useEffect(() => {
    const term = value.trim();
    if (term.length > 0 && term.length < liveMinChars) return;
    const t = setTimeout(() => applyRef.current(term, "replace"), liveDebounceMs);
    return () => clearTimeout(t);
  }, [value, liveDebounceMs, liveMinChars]);

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-busy={isPending || undefined}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            apply(value, "push");
          }
        }}
        className={cn("pl-8", isPending && "opacity-60")}
      />
    </div>
  );
}
