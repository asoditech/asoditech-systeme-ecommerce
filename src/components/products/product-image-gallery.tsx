"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Star, Trash2, Plus, ImageOff } from "lucide-react";
import { addProductImageAction, removeProductImageAction, setPrimaryProductImageAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult, IdResult } from "@/actions/types";

export interface GalleryImage {
  id: string;
  url: string;
  altText: string | null;
  position: number;
}

/**
 * Product image GALLERY (Batch 11) — the multi-image counterpart of the old
 * single-image `ProductImageForm`, which this replaces at its one call site
 * (`produits/[id]/page.tsx`). Every image is still a pasted link (no
 * upload/storage backend exists in this app — same convention as every other
 * image field here); the gallery adds add/remove/"set as principal" on top
 * of the existing `ProductImage[]` model, which already supported multiple
 * rows and a `position` for ordering — nothing here was previously exposed.
 *
 * Only rendered for an INTERNE product (see the three actions' own doc
 * comments) — the page already gates this the same way it gated the old form.
 */
export function ProductImageGallery({ productId, images }: { productId: string; images: GalleryImage[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [newUrl, setNewUrl] = useState("");
  const [preview, setPreview] = useState("");

  function run(fn: () => Promise<ActionResult<IdResult>>, success: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleAdd() {
    const url = newUrl.trim();
    if (!url) return;
    startTransition(async () => {
      const result = await addProductImageAction({ productId, imageUrl: url });
      if (result.ok) {
        toast.success("Image ajoutée.");
        setNewUrl("");
        setPreview("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const sorted = [...images].sort((a, b) => a.position - b.position);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Images</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {sorted.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ImageOff className="size-4" />
            Aucune image pour le moment.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {sorted.map((img) => (
              <div key={img.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary externally-hosted URL, can't be allow-listed for next/image */}
                <img
                  src={img.url}
                  alt={img.altText ?? ""}
                  loading="lazy"
                  className="size-20 rounded border object-cover"
                />
                {img.position === 0 ? (
                  <span className="absolute -top-2 -left-2 flex items-center gap-0.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                    <Star className="size-2.5" />
                    Principale
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="absolute -top-2 -left-2 size-6 opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    disabled={isPending}
                    aria-label="Définir comme image principale"
                    title="Définir comme image principale"
                    onClick={() => run(() => setPrimaryProductImageAction({ id: img.id }), "Image principale mise à jour.")}
                  >
                    <Star className="size-3" />
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="destructive"
                  className="absolute -top-2 -right-2 size-6 opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  disabled={isPending}
                  aria-label="Supprimer cette image"
                  title="Supprimer cette image"
                  onClick={() => run(() => removeProductImageAction({ id: img.id }), "Image supprimée.")}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="new-product-image-url">Ajouter une image</Label>
            <div className="flex items-center gap-3">
              <Input
                id="new-product-image-url"
                type="url"
                placeholder="https://…"
                value={newUrl}
                onChange={(e) => {
                  setNewUrl(e.target.value);
                  setPreview(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd();
                  }
                }}
              />
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element -- arbitrary externally-hosted URL, can't be allow-listed for next/image
                <img
                  src={preview}
                  alt=""
                  className="size-16 shrink-0 rounded border object-cover"
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                  onLoad={(e) => (e.currentTarget.style.visibility = "visible")}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Collez le lien d&apos;une image déjà hébergée ailleurs (aucun stockage de fichiers ici). La première
              image ajoutée devient automatiquement l&apos;image principale.
            </p>
          </div>
          <Button type="button" onClick={handleAdd} disabled={isPending || !newUrl.trim()} className="shrink-0">
            <Plus className="size-4" />
            Ajouter
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
