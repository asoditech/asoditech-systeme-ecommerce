"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { updateVariationDetailsAction, updateVariationSkuAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * Edit dialog for a single variation's ASODITECH-owned fields (Batch 4):
 * cost, sale price, image URL, active state — plus, since Batch 11, its SKU.
 * SKU is submitted through a SEPARATE small action (`updateVariationSkuAction`)
 * rather than folded into the main form: `updateVariationDetailsAction`'s own
 * doc comment documents that it never touches sku/attributes/price, and this
 * keeps that invariant intact instead of special-casing it. This whole
 * dialog is only ever rendered by the page for an INTERNE product
 * (`canEdit && !isExternal`), so no extra prop is needed here to gate it —
 * the server action re-checks the same boundary regardless.
 */
export function VariantEditDialog({
  variation,
  label,
  regularPrice,
}: {
  variation: { id: string; sku: string; cost: string | null; salePrice: string | null; imageUrl: string | null; isActive: boolean };
  label: string;
  /** The effective regular price (variation.price ?? product.price) — shown so the sale-price field's ceiling makes sense. */
  regularPrice: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [imagePreview, setImagePreview] = useState(variation.imageUrl ?? "");
  const [sku, setSku] = useState(variation.sku);
  const [skuError, setSkuError] = useState<string | null>(null);
  const [skuPending, startSkuTransition] = useTransition();

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

  function saveSku() {
    const next = sku.trim();
    if (!next || next === variation.sku) return;
    setSkuError(null);
    startSkuTransition(async () => {
      const result = await updateVariationSkuAction({ id: variation.id, sku: next });
      if (result.ok) {
        toast.success("SKU mis à jour.");
        router.refresh();
      } else {
        setSkuError(result.error);
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The input itself remounts fresh (base-ui unmounts closed dialog
        // content), but this preview state lives on the outer component and
        // would otherwise keep an abandoned, never-saved draft across a
        // close+reopen (Batch 8, Area 1) — resync it to the current value
        // every time the dialog opens. Same reasoning for the SKU draft.
        if (next) {
          setImagePreview(variation.imageUrl ?? "");
          setSku(variation.sku);
          setSkuError(null);
        }
      }}
    >
      <DialogTrigger render={<Button type="button" size="icon" variant="ghost" aria-label={`Modifier ${label}`} />}>
        <Pencil className="size-4" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5 border-b pb-3">
          <Label htmlFor={`vsku-${variation.id}`}>SKU</Label>
          <div className="flex gap-2">
            <Input
              id={`vsku-${variation.id}`}
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveSku();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={skuPending || !sku.trim() || sku.trim() === variation.sku}
              onClick={saveSku}
            >
              Enregistrer
            </Button>
          </div>
          {skuError && <p className="text-xs text-destructive">{skuError}</p>}
        </div>
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
