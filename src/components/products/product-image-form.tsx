"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateProductImageAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * The only image path for an INTERNE product — a pasted link, since this
 * app has no file-upload/storage backend. Never shown for a WooCommerce/
 * Shopify-sourced product: those get their image from the sync instead
 * (docs/adr/0010/0011), and this form's own action refuses them
 * server-side anyway if ever reached another way.
 */
export function ProductImageForm({ productId, currentUrl }: { productId: string; currentUrl: string | null }) {
  const router = useRouter();
  const [preview, setPreview] = useState(currentUrl ?? "");
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => updateProductImageAction(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success("Image mise à jour.");
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Image</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <input type="hidden" name="id" value={productId} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="product-image-url">Lien de l&apos;image</Label>
            <Input
              key={currentUrl ?? ""}
              id="product-image-url"
              name="imageUrl"
              type="url"
              placeholder="https://…"
              defaultValue={currentUrl ?? ""}
              onChange={(e) => setPreview(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Collez le lien d&apos;une image déjà hébergée ailleurs (aucun stockage de fichiers ici). Laissez vide
              pour retirer l&apos;image.
            </p>
          </div>
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
          <Button type="submit" disabled={isPending} className="shrink-0">
            {isPending ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
