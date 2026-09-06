import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * Third-party brand logos (public/brands/). Same `unoptimized` note as
 * BrandMark — Next 16's optimizer 500s on these small fixed assets.
 * Render inside a sized, `position: relative` box; the image fills it and
 * is letterboxed with `object-contain` so any aspect ratio sits centred.
 */
const BRAND_SRC = {
  woocommerce: "/brands/woocommerce.webp",
  shopify: "/brands/shopify.png",
  whatsapp: "/brands/whatsapp.webp",
  meta: "/brands/meta.png",
  google: "/brands/google.webp",
  "google-sheets": "/brands/google-sheets.webp",
  tiktok: "/brands/tiktok.png",
  ozonexpress: "/brands/ozonexpress.png",
  email: "/brands/email.png",
  ai: "/brands/ai.png",
  ameex: "/brands/ameex.png",
  speedaf: "/brands/speedaf.png",
  olivraison: "/brands/olivraison.png",
} as const;

export type BrandKey = keyof typeof BRAND_SRC;

export function BrandLogo({
  brand,
  label,
  className,
}: {
  brand: BrandKey;
  label: string;
  /** Sizes the box — e.g. "size-5", "size-9". Must resolve to a real size. */
  className?: string;
}) {
  return (
    <span className={cn("relative inline-block shrink-0", className)}>
      <Image src={BRAND_SRC[brand]} alt={label} fill sizes="48px" unoptimized className="object-contain" />
    </span>
  );
}

/** Logo on a white tile with a hairline ring — for card headers next to a title. */
export function BrandTile({ brand, label, className }: { brand: BrandKey; label: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-white p-1.5",
        className
      )}
    >
      <BrandLogo brand={brand} label={label} className="size-full" />
    </span>
  );
}
