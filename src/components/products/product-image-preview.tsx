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
 * Touch devices have no hover, so a tap toggles the same preview via
 * `onPointerUp`. `preventDefault` there suppresses the browser's
 * touch-to-click compatibility event, so the tap never also reaches an
 * ancestor `ClickableTableRow`'s `onClick` (which would otherwise
 * navigate away instead of showing the preview). Mouse clicks are left
 * alone — desktop keeps today's behaviour of falling through to the
 * row/link. Renders just `children` unchanged when there's no image, so
 * an un-photographed catalogue looks no different than today.
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
        render={
          <span
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onPointerUp={(e: React.PointerEvent<HTMLSpanElement>) => {
              if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
              e.preventDefault();
              e.stopPropagation();
              setOpen((prev) => !prev);
            }}
          />
        }
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
