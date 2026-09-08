"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Company-logo picker for the business settings form. No upload backend:
 * a picked image is resized client-side (canvas, max 320px, PNG) to a
 * small `data:image/png;base64,…` URI and written into a hidden input, so
 * it round-trips through the normal form POST like any other field. An
 * https URL can also be pasted directly. The resulting value shows on
 * printed reports and delivery invoices.
 */
const MAX_DIM = 320;
const MAX_BYTES = 1_400_000;

export function LogoField({ defaultValue }: { defaultValue: string | null }) {
  const [value, setValue] = useState(defaultValue ?? "");
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error("Choisissez un fichier image.");
      return;
    }
    try {
      const dataUri = await resizeToDataUri(file);
      if (dataUri.length > MAX_BYTES) {
        toast.error("Image trop lourde même après redimensionnement — essayez un logo plus simple.");
        return;
      }
      setValue(dataUri);
    } catch {
      toast.error("Impossible de lire cette image.");
    }
  }

  return (
    <div className="space-y-2 sm:col-span-2">
      <Label>Logo</Label>
      <input type="hidden" name="logoUrl" value={value} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="Logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-[10px] text-muted-foreground">Aucun</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              Importer une image
            </Button>
            {value && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setValue("")}>
                Retirer
              </Button>
            )}
          </div>
          <Input
            type="url"
            placeholder="…ou coller une URL https://"
            value={value.startsWith("data:") ? "" : value}
            onChange={(e) => setValue(e.target.value)}
            className="w-72 max-w-full"
          />
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <p className="text-xs text-muted-foreground">
        Apparaît sur les rapports imprimés et les factures de livraison. Redimensionné automatiquement.
      </p>
    </div>
  );
}

function resizeToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode"));
      img.onload = () => {
        const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("ctx"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}
