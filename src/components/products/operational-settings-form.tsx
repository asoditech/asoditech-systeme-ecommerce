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
  trackInventory,
  lowStockThreshold,
}: {
  productId: string;
  cost: string | null;
  trackInventory: boolean;
  lowStockThreshold: number;
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
        <CardTitle>Paramètres internes</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="id" value={productId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="op-cost">Coût d&apos;achat (MAD)</Label>
              <Input id="op-cost" name="cost" type="number" step="0.01" min="0" defaultValue={cost ?? ""} />
            </div>
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
