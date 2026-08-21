"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createProductAction, updateProductAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";
import type { Product, Category } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

// Prisma's Decimal fields aren't serializable across the Server->Client
// boundary — pages pass a plain-string version (see produits/[id]/page.tsx).
export type SerializedProduct = Omit<Product, "price" | "salePrice" | "cost"> & {
  price: string;
  salePrice: string | null;
  cost: string | null;
};

export function ProductForm({ product, categories }: { product?: SerializedProduct; categories: Category[] }) {
  const router = useRouter();
  const action = product ? updateProductAction : createProductAction;
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => action(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(product ? "Produit mis à jour." : "Produit créé.");
      router.push(`/produits/${state.data.id}`);
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          {product && <input type="hidden" name="id" value={product.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="name">Nom du produit</Label>
              <Input id="name" name="name" required defaultValue={product?.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sku">SKU</Label>
              <Input id="sku" name="sku" required defaultValue={product?.sku} />
              {state && !state.ok && state.fieldErrors?.sku && (
                <p className="text-xs text-destructive">{state.fieldErrors.sku[0]}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="categoryId">Catégorie</Label>
              <Select name="categoryId" defaultValue={product?.categoryId ?? undefined}>
                <SelectTrigger id="categoryId" className="w-full">
                  <SelectValue placeholder="Aucune catégorie">
                    {(value: string) => categories.find((c) => c.id === value)?.name ?? "Aucune catégorie"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="price">Prix de vente (MAD)</Label>
              <Input id="price" name="price" type="number" step="0.01" min="0" required defaultValue={product?.price} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="salePrice">Prix promotionnel (MAD)</Label>
              <Input id="salePrice" name="salePrice" type="number" step="0.01" min="0" defaultValue={product?.salePrice ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cost">Coût d&apos;achat (MAD)</Label>
              <Input id="cost" name="cost" type="number" step="0.01" min="0" defaultValue={product?.cost ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">Statut</Label>
              <Select name="status" defaultValue={product?.status ?? "BROUILLON"}>
                <SelectTrigger id="status" className="w-full">
                  <SelectValue>{(value: string) => PRODUCT_STATUS_LABELS[value]?.label ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PRODUCT_STATUS_LABELS).map(([value, meta]) => (
                    <SelectItem key={value} value={value}>
                      {meta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lowStockThreshold">Seuil de stock faible</Label>
              <Input
                id="lowStockThreshold"
                name="lowStockThreshold"
                type="number"
                min="0"
                defaultValue={product?.lowStockThreshold ?? 5}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="trackInventory" name="trackInventory" defaultChecked={product?.trackInventory ?? true} />
            <Label htmlFor="trackInventory" className="font-normal">
              Suivre le stock pour ce produit
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" rows={4} defaultValue={product?.description ?? ""} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : product ? "Enregistrer" : "Créer le produit"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
