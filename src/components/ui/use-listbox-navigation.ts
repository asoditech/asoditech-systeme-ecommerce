"use client";

import * as React from "react";
import { clampActive, listboxKey } from "@/lib/ui/listbox-navigation";

/**
 * Arrow / Enter / Escape navigation for a search input that drives a list of
 * options (combobox pattern). Spread `inputProps` on the input and
 * `optionProps(i)` on each option; the input keeps the focus, the active
 * option is announced through `aria-activedescendant` and scrolled into view.
 */
export function useListboxNavigation({
  id,
  count,
  onSelect,
  onClose,
}: {
  id: string;
  count: number;
  onSelect: (index: number) => void;
  onClose?: () => void;
}) {
  const [rawActive, setActive] = React.useState(-1);
  const active = clampActive(rawActive, count);
  const optionId = (i: number) => `${id}-opt-${i}`;

  React.useEffect(() => {
    if (active < 0) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const r = listboxKey(e.key, active, count);
    if (r.kind === "ignore") return;
    e.preventDefault();
    if (r.kind === "move") setActive(r.active);
    else if (r.kind === "select") onSelect(r.index);
    else onClose?.();
  }

  return {
    active,
    reset: () => setActive(-1),
    inputProps: {
      role: "combobox" as const,
      "aria-expanded": true,
      "aria-controls": `${id}-list`,
      "aria-autocomplete": "list" as const,
      "aria-activedescendant": active >= 0 ? optionId(active) : undefined,
      onKeyDown,
    },
    listProps: { id: `${id}-list`, role: "listbox" as const },
    optionProps: (i: number, selected = false) => ({
      id: optionId(i),
      role: "option" as const,
      "aria-selected": selected || i === active,
      "data-active": i === active ? "" : undefined,
      onMouseEnter: () => setActive(i),
    }),
  };
}
