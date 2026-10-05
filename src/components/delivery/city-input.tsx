"use client";

import { useEffect, useId, useState } from "react";
import { getDeliveryCitySuggestionsAction } from "@/actions/delivery";
import { Input } from "@/components/ui/input";
import type { CitySuggestions } from "@/lib/delivery-cities";

/**
 * City field for online orders / customers. When the company's delivery
 * carrier exposes a city list (src/lib/delivery-cities.ts), the field offers
 * it as searchable suggestions (native <datalist>); typing a city not in the
 * list stays possible, and with no carrier list — or if the carrier is
 * unavailable — it is the same free-text field as before. Never blocks entry.
 */
export function CityInput(props: React.ComponentProps<typeof Input>) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<CitySuggestions | null>(null);

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
  return (
    <>
      <Input {...props} list={list ? listId : undefined} autoComplete={list ? "off" : props.autoComplete} />
      {list && (
        <>
          <datalist id={listId}>
            {list.cities.map((city) => (
              <option key={city} value={city} />
            ))}
          </datalist>
          <p className="mt-1 text-xs text-muted-foreground">
            Villes desservies par {list.providerName} : choisissez dans la liste (saisie libre possible).
          </p>
        </>
      )}
    </>
  );
}
