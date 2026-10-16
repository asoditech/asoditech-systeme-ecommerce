"use client";

import type * as React from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectedLineChips } from "@/components/orders/selected-line-chips";
import { unitLineKey, type PickableUnit } from "@/lib/catalog/picker-session";

/**
 * The shared product result list (docs/adr/0061) for the multi-line pickers
 * built on the shared lookup (reception, in-store sale) — same interaction as
 * the order form's « Ajouter un produit » popover: the list STAYS OPEN after a
 * pick (click or keyboard), already-added articles carry a ✓, the articles
 * already on the document show as removable chips with « Terminé », and each
 * row names the exact variation. Keyboard navigation comes from the same
 * `useListboxNavigation` the order form uses — the caller spreads its
 * `inputProps` on the search input and passes `nav` here.
 */
export function UnitPickList<H>({
  id,
  hits,
  unitOf,
  isDisabled,
  meta,
  addedKeys,
  selected,
  onRemove,
  onPick,
  onDone,
  nav,
}: {
  id: string;
  hits: readonly H[];
  unitOf: (hit: H) => PickableUnit & { primaryBarcode?: string | null };
  isDisabled?: (hit: H) => boolean;
  meta?: (hit: H) => React.ReactNode;
  addedKeys: ReadonlySet<string>;
  selected: { key: string; label: string; quantity: number }[];
  onRemove?: (key: string) => void;
  onPick: (hit: H) => void;
  onDone: () => void;
  nav: {
    listProps: { id: string; role: "listbox" };
    optionProps: (i: number, selected?: boolean) => Record<string, unknown>;
  };
}) {
  if (hits.length === 0) return null;
  return (
    <div className="space-y-2" data-testid={`${id}-picker`}>
      {selected.length > 0 && (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <SelectedLineChips lines={selected} onRemove={onRemove} />
          </div>
          <Button type="button" size="sm" onClick={onDone}>
            Terminé
          </Button>
        </div>
      )}
      <ul
        {...nav.listProps}
        aria-label="Articles trouvés"
        className="max-h-80 divide-y divide-hairline overflow-y-auto rounded-2xl border border-hairline bg-popover text-sm shadow-popover"
      >
        {hits.map((hit, i) => {
          const u = unitOf(hit);
          const added = addedKeys.has(unitLineKey(u));
          const disabled = isDisabled?.(hit) ?? false;
          return (
            <li key={unitLineKey(u)} role="none">
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                // Keep the focus in the search field (combobox pattern): the
                // next typed or scanned code goes there, not to this row.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(hit)}
                {...nav.optionProps(i, added)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-row-hover disabled:opacity-50 data-[active]:bg-row-hover"
              >
                <span className="min-w-0">
                  {added && <Check className="mr-1 inline size-3.5 text-pill-green-fg" aria-label="déjà ajouté" />}
                  {u.name}
                  {u.variantLabel && <span className="text-muted-foreground"> — {u.variantLabel}</span>}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{u.primaryBarcode ?? u.sku}</span>
                </span>
                {meta && <span className="shrink-0 text-xs text-ink-secondary tabular-nums">{meta(hit)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
