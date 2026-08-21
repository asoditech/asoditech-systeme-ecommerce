"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import { adjustInventoryAction } from "@/actions/inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { INVENTORY_MOVEMENT_TYPE_LABELS } from "@/lib/status-labels";
import type { InventoryItem } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

const ADJUSTMENT_TYPES = ["AJUSTEMENT_POSITIF", "AJUSTEMENT_NEGATIF", "ENDOMMAGE", "RETOUR", "RECEPTION"] as const;

export function StockAdjustmentDialog({
  productId,
  variationId,
  warehouseId,
  label,
}: {
  productId?: string;
  variationId?: string;
  warehouseId: string;
  label: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<InventoryItem> | undefined, formData: FormData) => {
      const result = await adjustInventoryAction(formData);
      if (result.ok) {
        toast.success("Stock ajusté.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <SlidersHorizontal className="size-4" />
        Ajuster
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajuster le stock — {label}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          {productId && <input type="hidden" name="productId" value={productId} />}
          {variationId && <input type="hidden" name="variationId" value={variationId} />}
          <input type="hidden" name="warehouseId" value={warehouseId} />
          <div className="space-y-1.5">
            <Label htmlFor="type">Type d&apos;ajustement</Label>
            <Select name="type" defaultValue="AJUSTEMENT_POSITIF">
              <SelectTrigger id="type" className="w-full">
                <SelectValue>{(value: string) => INVENTORY_MOVEMENT_TYPE_LABELS[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {ADJUSTMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {INVENTORY_MOVEMENT_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="quantity">Quantité</Label>
            <Input id="quantity" name="quantity" type="number" min="1" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Motif (obligatoire)</Label>
            <Textarea id="reason" name="reason" rows={2} required />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Confirmer l'ajustement"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
