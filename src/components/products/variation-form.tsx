"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { createProductVariationAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import type { ActionResult, IdResult } from "@/actions/types";

export function VariationForm({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const [attrs, setAttrs] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const attributes = Object.fromEntries(
        attrs.filter((a) => a.key.trim() && a.value.trim()).map((a) => [a.key.trim(), a.value.trim()])
      );
      formData.set("attributes", JSON.stringify(attributes));
      const result = await createProductVariationAction(formData);
      if (result.ok) {
        toast.success("Variation ajoutée.");
        setOpen(false);
        setAttrs([{ key: "", value: "" }]);
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Ajouter une variation
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="productId" value={productId} />
          <div className="space-y-1.5">
            <Label htmlFor="variation-sku">SKU de la variation</Label>
            <Input id="variation-sku" name="sku" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="variation-price">Prix (optionnel, remplace le prix produit)</Label>
              <Input id="variation-price" name="price" type="number" step="0.01" min="0" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="variation-cost">Coût (optionnel)</Label>
              <Input id="variation-cost" name="cost" type="number" step="0.01" min="0" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Attributs (ex. Couleur, Taille)</Label>
            {attrs.map((attr, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  placeholder="Attribut (Couleur)"
                  value={attr.key}
                  onChange={(e) => setAttrs((prev) => prev.map((a, j) => (j === i ? { ...a, key: e.target.value } : a)))}
                />
                <Input
                  placeholder="Valeur (Rouge)"
                  value={attr.value}
                  onChange={(e) => setAttrs((prev) => prev.map((a, j) => (j === i ? { ...a, value: e.target.value } : a)))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Supprimer cet attribut"
                  onClick={() => setAttrs((prev) => prev.filter((_, j) => j !== i))}
                  disabled={attrs.length === 1}
                >
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setAttrs((prev) => [...prev, { key: "", value: "" }])}>
              <Plus className="size-4" />
              Ajouter un attribut
            </Button>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Ajout..." : "Ajouter la variation"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
