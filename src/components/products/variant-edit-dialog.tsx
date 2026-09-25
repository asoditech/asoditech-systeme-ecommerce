"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { updateVariationDetailsAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * Edit dialog for a single variation's ASODITECH-owned fields (Batch 4):
 * cost, sale price, image URL, active state. Never sku/attributes/price —
 * those stay provider-owned once synced (see updateVariationDetailsAction's
 * own doc comment) and have no edit control here.
 */
export function VariantEditDialog({
  variation,
  label,
  regularPrice,
}: {
  variation: { id: string; cost: string | null; salePrice: string | null; imageUrl: string | null; isActive: boolean };
  label: string;
  /** The effective regular price (variation.price ?? product.price) — shown so the sale-price field's ceiling makes sense. */
  regularPrice: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [imagePreview, setImagePreview] = useState(variation.imageUrl ?? "");

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await updateVariationDetailsAction(formData);
      if (result.ok) {
        toast.success("Variation mise à jour.");
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
      <DialogTrigger render={<Button type="button" size="icon" variant="ghost" aria-label={`Modifier ${label}`} />}>
        <Pencil className="size-4" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="id" value={variation.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`vc-${variation.id}`}>Coût d&apos;achat (MAD)</Label>
              <Input id={`vc-${variation.id}`} name="cost" type="number" step="0.01" min="0" defaultValue={variation.cost ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`vs-${variation.id}`}>Prix promotionnel (MAD)</Label>
              <Input id={`vs-${variation.id}`} name="salePrice" type="number" step="0.01" min="0" defaultValue={variation.salePrice ?? ""} />
              <p className="text-xs text-muted-foreground">Ne doit pas dépasser le prix normal ({regularPrice} MAD).</p>
              {state && !state.ok && state.fieldErrors?.salePrice && (
                <p className="text-xs text-destructive">{state.fieldErrors.salePrice[0]}</p>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`vi-${variation.id}`}>Lien de l&apos;image (optionnel)</Label>
            <div className="flex items-end gap-3">
              <Input
                id={`vi-${variation.id}`}
                name="imageUrl"
                type="url"
                placeholder="https://…"
                className="flex-1"
                defaultValue={variation.imageUrl ?? ""}
                onChange={(e) => setImagePreview(e.target.value)}
              />
              {imagePreview && (
                // eslint-disable-next-line @next/next/no-img-element -- arbitrary externally-hosted URL, can't be allow-listed for next/image
                <img
                  src={imagePreview}
                  alt=""
                  className="size-16 shrink-0 rounded border object-cover"
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                  onLoad={(e) => (e.currentTarget.style.visibility = "visible")}
                />
              )}
            </div>
            {state && !state.ok && state.fieldErrors?.imageUrl && (
              <p className="text-xs text-destructive">{state.fieldErrors.imageUrl[0]}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id={`va-${variation.id}`} name="isActive" defaultChecked={variation.isActive} />
            <Label htmlFor={`va-${variation.id}`} className="font-normal">
              Active — vendable en ligne, en magasin et au POS
            </Label>
          </div>
          {!variation.isActive && (
            <p className="text-xs text-muted-foreground">
              Une variation inactive reste visible ici et dans l&apos;historique (commandes, ventes, réceptions), mais
              ne peut plus être sélectionnée pour une nouvelle vente.
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
