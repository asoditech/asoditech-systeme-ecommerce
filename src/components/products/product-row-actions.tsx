"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RemoveProductDialog } from "@/components/products/remove-product-button";

/**
 * Row menu of the products table — a shortcut to the SAME « Retirer du
 * catalogue » the product page offers (RemoveProductDialog → removeProductAction:
 * `products.edit`, delete only when nothing references the product, otherwise
 * archive; audited). The page renders it only for `products.edit` holders.
 *
 * The wrapper stops click/keyboard events: the row itself navigates on click,
 * and React events from the portaled menu/dialog bubble through it.
 */
export function ProductRowActions({ productId, productName }: { productId: string; productName: string }) {
  const [removeOpen, setRemoveOpen] = useState(false);
  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions pour ${productName}`} />}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem render={<Link href={`/produits/${productId}`} />}>
            <ExternalLink className="size-4" />
            Ouvrir la fiche produit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setRemoveOpen(true)}>
            <Trash2 className="size-4" />
            Retirer du catalogue
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RemoveProductDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        productId={productId}
        productName={productName}
        after="refresh"
      />
    </div>
  );
}
