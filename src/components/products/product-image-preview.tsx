"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Wraps a product name so hovering it shows a small image preview,
 * instead of a permanent image column/thumbnail in every list — keeps
 * product and order-line tables fast and dense while still giving
 * instant visual confirmation on demand (client request: keep the
 * lists exactly as they are, just add this on hover).
 *
 * Hover-only for now: touch devices have no hover, so a tap still does
 * whatever it always did (navigate the row/link) rather than risk
 * breaking that. Renders just `children` unchanged when there's no
 * image, so an un-photographed catalogue looks no different than today.
 */
export function ProductImagePreview({
  imageUrl,
  name,
  children,
}: {
  imageUrl: string | null | undefined;
  name: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  if (!imageUrl) return <>{children}</>;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        nativeButton={false}
        render={<span onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} />}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" side="right" align="start">
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant/WooCommerce/Shopify host, can't be allow-listed for next/image */}
        <img src={imageUrl} alt={name} className="aspect-square w-full rounded object-cover" />
      </PopoverContent>
    </Popover>
  );
}
