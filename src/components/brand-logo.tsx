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
  shopify: "/brands/shopify.webp",
  whatsapp: "/brands/whatsapp.webp",
  meta: "/brands/meta.webp",
  google: "/brands/google.webp",
  "google-sheets": "/brands/google-sheets.webp",
  tiktok: "/brands/tiktok.webp",
  ozonexpress: "/brands/ozonexpress.webp",
  aramex: "/brands/aramex.webp",
  email: "/brands/email.webp",
  ai: "/brands/ai.webp",
  ameex: "/brands/ameex.png",
  speedaf: "/brands/speedaf.png",
  olivraison: "/brands/olivraison.png",
} as const;

export type BrandKey = keyof typeof BRAND_SRC;

// A couple of the source files above (meta.webp in particular) ship with a
// lot of transparent margin baked into the canvas itself — at any fixed
// box size the mark renders visibly smaller than every sibling logo next
// to it. Rather than re-export the asset, scale it up from its own
// center; `overflow-hidden` on the wrapping span below clips it back to
// the box instead of letting it spill past a rounded/bordered container.
const BRAND_ZOOM: Partial<Record<BrandKey, number>> = {
  meta: 1.6,
};

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
  const zoom = BRAND_ZOOM[brand];
  return (
    <span className={cn("relative inline-block shrink-0 overflow-hidden", className)}>
      <Image
        src={BRAND_SRC[brand]}
        alt={label}
        fill
        sizes="48px"
        unoptimized
        className="object-contain"
        style={zoom ? { transform: `scale(${zoom})` } : undefined}
      />
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
