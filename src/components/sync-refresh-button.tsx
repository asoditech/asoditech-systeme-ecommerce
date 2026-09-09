"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { syncConnectedOrdersAction, syncConnectedProductsAction } from "@/actions/sync";
import { Button } from "@/components/ui/button";

/**
 * « Synchroniser » / « Actualiser » — on the Commandes / Produits / Stock
 * pages. When the current user can sync (`canSync`, i.e. has
 * `integrations.manage` and a store is connected), one click pulls the
 * latest from WooCommerce / Shopify and then reloads the page. Otherwise
 * it is a plain page refresh so a confirmateur / warehouse user can still
 * pick up webhook-imported changes without a hard reload.
 */
export function SyncRefreshButton({
  resource,
  canSync,
  size = "sm",
}: {
  resource: "orders" | "products";
  canSync: boolean;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      if (canSync) {
        const res =
          resource === "orders" ? await syncConnectedOrdersAction() : await syncConnectedProductsAction();
        if (res.ok) {
          const parts = res.data.ran.map(
            (r) => `${r.platform} : ${r.imported} importé(s), ${r.updated} mis à jour${r.hasMore ? " (suite…)" : ""}`
          );
          toast.success(parts.join(" · ") || "Synchronisation terminée.");
        } else {
          toast.error(res.error);
        }
      }
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" size={size} disabled={isPending} onClick={onClick}>
      <RefreshCw className={isPending ? "size-4 animate-spin" : "size-4"} />
      {canSync ? (isPending ? "Synchronisation…" : "Synchroniser") : isPending ? "Actualisation…" : "Actualiser"}
    </Button>
  );
}
