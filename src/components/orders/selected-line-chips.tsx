"use client";

import { X } from "lucide-react";
import { CHIP } from "@/components/orders/product-chips";

/** Picker summary: what is already in the order/cart, removable, while the picker stays open. */
export function SelectedLineChips({
  lines,
  onRemove,
}: {
  lines: { key: string; label: string; quantity: number }[];
  onRemove?: (key: string) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1" aria-label="Articles sélectionnés">
      {lines.map((l) => (
        <span key={l.key} className={`${CHIP} border-primary/30 bg-primary/10`}>
          <span className="truncate">{l.label}</span>
          <span className="shrink-0 text-muted-foreground">×{l.quantity}</span>
          {onRemove && (
            <button type="button" aria-label={`Retirer ${l.label}`} className="shrink-0 rounded-full hover:text-destructive" onClick={() => onRemove(l.key)}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
