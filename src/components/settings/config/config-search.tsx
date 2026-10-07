"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { CONFIG_SECTIONS, searchSettings, sectionHref, type SettingIndexEntry } from "@/lib/settings/configuration-model";

/**
 * « Rechercher un réglage » — searches THIS page's settings only (the index
 * built from the settings that exist for this tenant/user), accent- and
 * case-insensitive. Enter / click jumps to the setting's tile, which is
 * highlighted through its `:target` style. Not a global search.
 */
export function ConfigSearch({ index, currentSection }: { index: SettingIndexEntry[]; currentSection: string }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = searchSettings(index, query).slice(0, 6);
  const open = query.trim().length > 0;

  function go(entry: SettingIndexEntry) {
    setQuery("");
    if (entry.section === currentSection) {
      // Same section: no navigation, just bring the tile into view.
      window.history.replaceState(null, "", `#${entry.anchor}`);
      flashAnchor(entry.anchor);
    } else {
      router.push(sectionHref(entry.section, entry.anchor));
    }
  }

  return (
    <div className="relative w-full sm:w-80">
      <Search className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Rechercher un réglage"
        placeholder="Rechercher un réglage…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && results[active]) {
            e.preventDefault();
            go(results[active]);
          } else if (e.key === "Escape") {
            setQuery("");
          }
        }}
        className="h-10 w-full rounded-xl border bg-background/80 pr-3 pl-9 text-sm shadow-xs backdrop-blur outline-none transition-shadow placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/35"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-xl border bg-popover p-1 shadow-popover"
        >
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-muted-foreground">Aucun réglage ne correspond.</li>
          ) : (
            results.map((r, i) => (
              <li key={`${r.section}-${r.anchor}-${r.label}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r)}
                  className={cn("flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm", i === active && "bg-muted")}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.label}</span>
                    <span className="block text-xs text-muted-foreground">{CONFIG_SECTIONS.find((s) => s.id === r.section)?.label}</span>
                  </span>
                  {i === active && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** Scrolls a settings tile into view and flashes it briefly (`data-flash`). */
export function flashAnchor(id: string) {
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.setAttribute("data-flash", "");
  window.setTimeout(() => el.removeAttribute("data-flash"), 1800);
}

/**
 * On arriving in a section with `…#anchor` (search result, attention item),
 * highlight that tile. Client navigation does not update CSS `:target`,
 * hence this small effect.
 */
export function HashFocus({ section }: { section: string }) {
  useEffect(() => {
    flashAnchor(decodeURIComponent(window.location.hash.slice(1)));
  }, [section]);
  return null;
}
