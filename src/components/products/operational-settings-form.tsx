"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateProductOperationalSettingsAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * The only fields ASODITECH still edits directly for a WooCommerce/
 * Shopify-sourced product — see updateProductOperationalSettingsAction.
 * Product definition (name/sku/price/description/status/category) is
 * never edited here; see docs/adr/0017-product-management-boundary.md.
 */
export function OperationalSettingsForm({
  productId,
  cost,
  canEditCost,
  trackInventory,
  lowStockThreshold,
  trackingHint,
}: {
  productId: string;
  cost: string | null;
  /** `finance.view` (Phase 4B): without it the purchase cost is neither shown
   * nor submitted — and the server ignores it anyway. */
  canEditCost: boolean;
  trackInventory: boolean;
  lowStockThreshold: number;
  /** Who decides « Suivre le stock » for an imported product, and what it causes (product page). */
  trackingHint?: string;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) =>
      updateProductOperationalSettingsAction(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success("Paramètres internes mis à jour.");
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle accent="purple">Paramètres internes</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="id" value={productId} />
          <div className="grid gap-4 sm:grid-cols-2">
            {canEditCost && (
              <div className="space-y-1.5">
                <Label htmlFor="op-cost">Coût global du produit (MAD)</Label>
                <Input id="op-cost" name="cost" type="number" step="0.01" min="0" defaultValue={cost ?? ""} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="op-lowStockThreshold">Seuil de stock faible</Label>
              <Input id="op-lowStockThreshold" name="lowStockThreshold" type="number" min="0" defaultValue={lowStockThreshold} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="op-trackInventory" name="trackInventory" defaultChecked={trackInventory} />
            <Label htmlFor="op-trackInventory" className="font-normal">
              Suivre le stock pour ce produit
            </Label>
          </div>
          {trackingHint && <p className="-mt-2 pl-6 text-xs text-muted-foreground">{trackingHint}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
