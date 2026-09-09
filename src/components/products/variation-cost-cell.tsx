"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateVariationOperationalSettingsAction } from "@/actions/products";
import { Input } from "@/components/ui/input";

/**
 * Inline per-variation purchase-cost editor for the product detail
 * Variations tab. Saves on blur / Enter. This is the only way to set a
 * cost for a WooCommerce/Shopify variable product's colours & sizes — the
 * parent-product cost field can't represent per-variation costs.
 */
export function VariationCostCell({
  variationId,
  cost,
  currency = "MAD",
}: {
  variationId: string;
  cost: string | null;
  currency?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLInputElement>(null);
  const [committed, setCommitted] = useState(cost ?? "");

  function save() {
    const next = (ref.current?.value ?? "").trim();
    if (next === committed) return;
    const fd = new FormData();
    fd.set("id", variationId);
    fd.set("cost", next);
    startTransition(async () => {
      const res = await updateVariationOperationalSettingsAction(fd);
      if (res.ok) {
        setCommitted(next);
        toast.success("Coût enregistré.");
        router.refresh();
      } else {
        toast.error(res.error);
        if (ref.current) ref.current.value = committed;
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <Input
        ref={ref}
        type="number"
        step="0.01"
        min="0"
        defaultValue={committed}
        placeholder="—"
        aria-label="Coût d'achat de la variation"
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="h-8 w-20 shrink-0 text-right tabular-nums"
        disabled={isPending}
      />
      <span className="shrink-0 text-xs text-muted-foreground">{currency}</span>
    </div>
  );
}
