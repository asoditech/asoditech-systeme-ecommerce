"use client";

import { useEffect, useId, useState } from "react";
import { Check, Loader2, MapPin, Search } from "lucide-react";
import { getDeliveryCitySuggestionsAction } from "@/actions/delivery";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { cityMatchKey, filterCities, type CitySuggestions } from "@/lib/delivery-cities";

type CityInputProps = Omit<React.ComponentProps<typeof Input>, "value" | "defaultValue" | "onChange"> & {
  /** Controlled value (order form). */
  value?: string;
  /** Uncontrolled initial value (customer form, shipping-address dialog). */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

/**
 * City field for online orders / customers. When the company's delivery
 * carrier exposes a city list (src/lib/delivery-cities.ts), typing in the field
 * filters that list in a dropdown styled like the app's other popovers /
 * command lists (keyboard: ↑ ↓ Entrée Échap). Typing a city that is not in the
 * list stays possible — it is the same free-text field (same `name`, same form
 * value) as before; with no carrier list, or if the carrier is unavailable,
 * no dropdown is shown at all. Never blocks entry.
 */
export function CityInput({ value, defaultValue, onValueChange, className, onFocus, onBlur, onKeyDown, ...inputProps }: CityInputProps) {
  const listId = useId();
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue ?? "");
  const current = controlled ? value : inner;
  const [suggestions, setSuggestions] = useState<CitySuggestions | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getDeliveryCitySuggestionsAction()
      .then((s) => {
        if (!cancelled) setSuggestions(s);
      })
      .catch(() => {
        if (!cancelled) setSuggestions({ mode: "free", reason: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const list = suggestions?.mode === "list" ? suggestions : null;
  const loading = suggestions === null;
  const matches = list ? filterCities(list.cities, current) : [];
  const panelOpen = open && (list !== null || loading);
  const selectedKey = cityMatchKey(current);
  const optionId = (i: number) => `${listId}-option-${i}`;

  function setValue(next: string) {
    if (!controlled) setInner(next);
    onValueChange?.(next);
  }

  function choose(city: string) {
    setValue(city);
    setOpen(false);
  }

  return (
    <div className="relative">
      <Input
        {...inputProps}
        value={current}
        autoComplete={list ? "off" : inputProps.autoComplete}
        role={list ? "combobox" : undefined}
        aria-autocomplete={list ? "list" : undefined}
        aria-expanded={list ? panelOpen : undefined}
        aria-controls={list ? listId : undefined}
        aria-activedescendant={panelOpen && list && matches.length > 0 ? optionId(active) : undefined}
        className={className}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={(e) => {
          setOpen(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setOpen(false);
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (list) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && panelOpen && matches[active]) {
              e.preventDefault();
              choose(matches[active]);
            } else if (e.key === "Escape" && panelOpen) {
              // Close the list only — don't also close a surrounding dialog.
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }
          onKeyDown?.(e);
        }}
      />

      {panelOpen && (
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg bg-popover text-sm text-popover-foreground shadow-popover ring-1 ring-border"
          // Keep focus in the input while clicking an option (blur would close the list first).
          onMouseDown={(e) => e.preventDefault()}
        >
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Chargement des villes…
            </div>
          ) : list ? (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                <Search className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">
                  Villes desservies par <span className="font-medium text-foreground">{list.providerName}</span>
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {matches.length}
                  {matches.length === 50 ? "+" : ""}
                </span>
              </div>
              {matches.length === 0 ? (
                <div className="px-3 py-5 text-center">
                  <p className="text-sm font-medium">Aucune ville trouvée</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">La ville saisie sera utilisée telle quelle.</p>
                </div>
              ) : (
                <ul id={listId} role="listbox" aria-label="Villes" className="max-h-60 scroll-py-1 overflow-y-auto p-1">
                  {matches.map((city, i) => {
                    const selected = cityMatchKey(city) === selectedKey;
                    return (
                      <li
                        key={city}
                        id={optionId(i)}
                        role="option"
                        aria-selected={selected}
                        data-active={i === active || undefined}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(city)}
                        className={cn(
                          "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 select-none",
                          i === active && "bg-accent text-accent-foreground"
                        )}
                      >
                        <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{city}</span>
                        {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
