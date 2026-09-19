"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Barcode as BarcodeIcon, Star, Trash2, Plus } from "lucide-react";
import {
  addBarcodeAction,
  removeBarcodeAction,
  setPrimaryBarcodeAction,
  updateProductReferenceAction,
  setProductChannelsAction,
} from "@/actions/catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Catalog identity — reference, barcodes and channel availability
 * (docs/adr/0038). All of it is ASODITECH-owned, so it stays editable on a
 * WooCommerce/Shopify product too (docs/adr/0017); product NAME/SKU/price/
 * category are NOT editable here.
 */

export interface IdentityBarcode {
  id: string;
  code: string;
  isPrimary: boolean;
}

export interface IdentityUnit {
  /** null for a simple product's own codes; the variation id otherwise. */
  variationId: string | null;
  label: string;
  sku: string;
  barcodes: IdentityBarcode[];
}

export interface IdentityChannel {
  id: string;
  name: string;
  kind: "ONLINE" | "OFFLINE";
}

export function ProductIdentityPanel({
  productId,
  reference,
  units,
  channels,
  enabledChannelIds,
  canEdit,
}: {
  productId: string;
  reference: string | null;
  /** The sellable units: ONE entry (the product itself) for a simple product, one per variation otherwise. */
  units: IdentityUnit[];
  channels: IdentityChannel[];
  enabledChannelIds: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [ref, setRef] = useState(reference ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<Set<string>>(new Set(enabledChannelIds));

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error ?? "Action impossible.");
      }
    });
  }

  const unitKey = (u: IdentityUnit) => u.variationId ?? "product";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Référence du modèle</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Regroupe toutes les tailles et couleurs d&apos;un même modèle (ex. « SKOUBA »). Le SKU reste la référence
            unique de chaque article vendable.
          </p>
          <div className="flex max-w-md gap-2">
            <Input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="Référence modèle"
              disabled={!canEdit}
              aria-label="Référence du modèle"
            />
            {canEdit && (
              <Button
                type="button"
                disabled={isPending || ref.trim() === (reference ?? "")}
                onClick={() => run(() => updateProductReferenceAction({ productId, reference: ref }), "Référence enregistrée.")}
              >
                Enregistrer
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Codes-barres</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Un code-barres identifie un article vendable (un produit simple, ou une variation taille/couleur). Plusieurs
            codes sont possibles ; un seul est principal. Les codes sont opaques : la taille et la couleur ne sont jamais
            déduites du code.
          </p>
          {units.map((u) => (
            <div key={unitKey(u)} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{u.label}</span>
                <span className="text-xs text-muted-foreground">SKU {u.sku}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {u.barcodes.length === 0 && <span className="text-xs text-muted-foreground">Aucun code-barres.</span>}
                {u.barcodes.map((b) => (
                  <Badge key={b.id} variant={b.isPrimary ? "default" : "outline"} className="gap-1.5 font-mono">
                    <BarcodeIcon className="size-3" />
                    {b.code}
                    {b.isPrimary && <Star className="size-3" aria-label="Principal" />}
                    {canEdit && !b.isPrimary && (
                      <button
                        type="button"
                        className="text-[10px] underline"
                        onClick={() => run(() => setPrimaryBarcodeAction({ barcodeId: b.id }), "Code principal mis à jour.")}
                      >
                        principal
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`Supprimer le code ${b.code}`}
                        onClick={() => run(() => removeBarcodeAction({ barcodeId: b.id }), "Code-barres supprimé.")}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    )}
                  </Badge>
                ))}
              </div>
              {canEdit && (
                <div className="flex max-w-md gap-2">
                  <Input
                    value={drafts[unitKey(u)] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [unitKey(u)]: e.target.value }))}
                    placeholder="Scanner ou saisir un code-barres"
                    aria-label={`Nouveau code-barres pour ${u.label}`}
                    onKeyDown={(e) => {
                      // A hardware scanner types the code then presses Enter.
                      if (e.key === "Enter") {
                        e.preventDefault();
                        (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isPending || !(drafts[unitKey(u)] ?? "").trim()}
                    onClick={() =>
                      run(
                        async () => {
                          const result = await addBarcodeAction(
                            u.variationId
                              ? { variationId: u.variationId, code: drafts[unitKey(u)] }
                              : { productId, code: drafts[unitKey(u)] }
                          );
                          if (result.ok) setDrafts((d) => ({ ...d, [unitKey(u)]: "" }));
                          return result;
                        },
                        "Code-barres ajouté."
                      )
                    }
                  >
                    <Plus className="size-4" />
                    Ajouter
                  </Button>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Canaux de vente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Où ce produit peut être vendu. C&apos;est une autorisation de vente, pas un stock : le stock physique reste
            sur les emplacements et n&apos;est jamais dupliqué par canal.
          </p>
          {channels.length === 0 && <p className="text-sm text-muted-foreground">Aucun canal de vente actif.</p>}
          <div className="flex flex-col gap-2">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={enabled.has(c.id)}
                  disabled={!canEdit}
                  onCheckedChange={(checked) =>
                    setEnabled((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(c.id);
                      else next.delete(c.id);
                      return next;
                    })
                  }
                />
                <span>{c.name}</span>
                <Badge variant="outline">{c.kind === "ONLINE" ? "En ligne" : "Magasin"}</Badge>
              </label>
            ))}
          </div>
          {canEdit && channels.length > 0 && (
            <Button
              type="button"
              disabled={isPending}
              onClick={() =>
                run(() => setProductChannelsAction({ productId, salesChannelIds: [...enabled] }), "Canaux enregistrés.")
              }
            >
              Enregistrer les canaux
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
