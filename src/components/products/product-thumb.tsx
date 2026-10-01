import { Package } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phase 5 visual QA — the fixed-size product thumbnail every product row
 * leads with. A product without an image still gets the SAME footprint (a
 * neutral package glyph), so a list mixing both keeps one aligned identity
 * column instead of names jumping left and right.
 */
export function ProductThumb({ imageUrl, className }: { imageUrl?: string | null; className?: string }) {
  return imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant/WooCommerce/Shopify host, can't be allow-listed for next/image
    <img src={imageUrl} alt="" className={cn("size-10 shrink-0 rounded-lg border bg-muted object-cover", className)} />
  ) : (
    <span
      aria-hidden="true"
      className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg border border-dashed bg-muted/50 text-muted-foreground/70", className)}
    >
      <Package className="size-4" />
    </span>
  );
}
