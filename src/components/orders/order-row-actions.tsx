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
import { PurgeOrderDialog, type PurgeOrderSummary } from "@/components/orders/purge-order-dialog";

/**
 * Row menu of the orders table — a shortcut to the SAME « Purger cette commande
 * de test » the order page offers (PurgeOrderDialog → previewOrderPurgeAction /
 * purgeTestOrderAction): same eligibility re-check under lock, same two
 * confirmations, same audit. The page renders it only for `orders.purge`
 * holders and only on rows that can be a purge candidate; the dialog loads the
 * full server preview when it opens and explains a refusal.
 *
 * The wrapper stops click/keyboard events: the row itself navigates on click,
 * and React events from the portaled menu/dialog bubble through it.
 */
export function OrderRowActions({ orderHref, summary }: { orderHref: string; summary: PurgeOrderSummary }) {
  const [purgeOpen, setPurgeOpen] = useState(false);
  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Actions pour la commande ${summary.orderLabel}`} />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem render={<Link href={orderHref} />}>
            <ExternalLink className="size-4" />
            Ouvrir la commande
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setPurgeOpen(true)}>
            <Trash2 className="size-4" />
            Purger cette commande de test
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PurgeOrderDialog open={purgeOpen} onOpenChange={setPurgeOpen} summary={summary} after="refresh" />
    </div>
  );
}
