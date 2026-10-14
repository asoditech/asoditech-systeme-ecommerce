"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useListboxNavigation } from "@/components/ui/use-listbox-navigation";
import { lookupTraceUnitsAction, type TracePickerUnit } from "@/actions/traceability";
import { inactiveUnitLabel, traceabilityUnitHref, traceabilitySearchHref, traceUnitKey } from "@/lib/traceability-scan";
import { cn } from "@/lib/utils";

const SEARCH_DELAY_MS = 250;

/**
 * « Traçabilité » search field with a product picker. Clicking it lists the
 * first articles; typing searches by name, SKU/reference, barcode or label QR
 * (lookupTraceUnitsAction = the page's own lookup). Picking an article — or a
 * variation — opens it through the page's existing `?q=…&unit=…` URL; Enter on
 * free text (or « Rechercher « … » ») keeps the old behaviour: `?q=` only, so a
 * hand scanner's Enter and the « N articles correspondent » list work as before.
 * Read-only: navigating is a GET. Keyboard: ↑/↓, Enter, Escape (combobox pattern).
 */
export function TraceUnitPicker({ defaultValue = "", className }: { defaultValue?: string; className?: string }) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [query, setQuery] = React.useState(defaultValue);
  const [open, setOpen] = React.useState(false);
  // The last answer and the search it answers: until the answer for the
  // CURRENT text arrives the list says « Recherche… », never a premature
  // « Aucun article trouvé ».
  const [result, setResult] = React.useState<{ query: string; units: TracePickerUnit[]; error: boolean } | null>(null);
  const requestId = React.useRef(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Search while open (debounced); the latest request wins.
  React.useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      lookupTraceUnitsAction({ query })
        .then((found) => {
          if (id === requestId.current) setResult({ query, units: found, error: false });
        })
        .catch(() => {
          if (id === requestId.current) setResult({ query, units: [], error: true });
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, query]);

  const units = result?.units ?? [];
  const loading = !result || result.query !== query;
  const error = !loading && result.error;

  const term = query.trim();
  // Option 0 = « Rechercher « term » » (free-text search, as before), then the articles.
  const hasSearchOption = term.length > 0;
  const optionCount = (hasSearchOption ? 1 : 0) + units.length;

  function go(href: string | null) {
    if (!href) return;
    setOpen(false);
    startTransition(() => router.push(href));
  }
  const searchFreeText = () => go(traceabilitySearchHref(term));
  // The article comes from `result` — possibly the previous search while the
  // new one is pending — so its URL carries THAT search: the page's lookup on
  // it is what found the article, so the page opens it (never a `unit` the
  // new text does not match).
  const pick = (unit: TracePickerUnit) => go(traceabilityUnitHref(result?.query ?? term, unit));

  const nav = useListboxNavigation({
    id: "trace-unit-picker",
    count: open ? optionCount : 0,
    onSelect: (i) => {
      if (hasSearchOption && i === 0) searchFreeText();
      else pick(units[i - (hasSearchOption ? 1 : 0)]);
    },
    onClose: () => setOpen(false),
  });

  return (
    <div
      ref={containerRef}
      className={cn("relative", className)}
      onBlur={(e) => {
        if (!containerRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        {...nav.inputProps}
        aria-expanded={open}
        aria-label="Rechercher un article à tracer"
        value={query}
        placeholder="Code-barres, référence, SKU ou nom…"
        className="pl-8"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          nav.reset();
        }}
        onKeyDown={(e) => {
          // Enter with no highlighted article = free-text search (hand scanners end with Enter).
          if (e.key === "Enter" && nav.active < 0) {
            e.preventDefault();
            searchFreeText();
            return;
          }
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) setOpen(true);
          nav.inputProps.onKeyDown(e);
        }}
      />
      {open && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-popover">
          <ul {...nav.listProps} aria-label="Articles" className="max-h-80 overflow-y-auto p-1">
            {hasSearchOption && (
              <li
                {...nav.optionProps(0)}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={searchFreeText}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm data-active:bg-row-hover"
              >
                <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">
                  Rechercher « <span className="font-medium">{term}</span> »
                </span>
              </li>
            )}
            {units.map((u, i) => {
              const index = i + (hasSearchOption ? 1 : 0);
              const inactive = inactiveUnitLabel(u.status);
              return (
                <li
                  key={traceUnitKey(u)}
                  {...nav.optionProps(index)}
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(u)}
                  className="cursor-pointer rounded-lg px-2 py-1.5 text-sm data-active:bg-row-hover"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-medium [overflow-wrap:anywhere]">
                    {u.name}
                    {u.variantLabel && <span className="font-normal text-muted-foreground">— {u.variantLabel}</span>}
                    {inactive && (
                      <Badge variant="outline" className="h-4 px-1 text-xs">
                        {inactive}
                      </Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[u.sku, u.primaryBarcode, u.categoryName].filter(Boolean).join(" · ")}
                  </span>
                </li>
              );
            })}
          </ul>
          {(loading || error || (!loading && units.length === 0)) && (
            <p className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground" role="status">
              {loading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> Recherche…
                </>
              ) : error ? (
                "Recherche impossible — réessayez."
              ) : (
                "Aucun article trouvé."
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
