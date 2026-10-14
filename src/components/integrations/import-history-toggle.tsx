"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { setWooCommerceImportHistoricalOrdersAction } from "@/actions/woocommerce";
import { setShopifyImportHistoricalOrdersAction } from "@/actions/shopify";
import { formatDateTime } from "@/lib/format";

const ACTIONS = {
  WOOCOMMERCE: setWooCommerceImportHistoricalOrdersAction,
  SHOPIFY: setShopifyImportHistoricalOrdersAction,
} as const;

/**
 * « Importer l'historique des commandes » — per connection, ON by default
 * (unchanged behavior). OFF: « Synchroniser les commandes » ignores orders
 * placed before the moment it was switched off; newer orders keep arriving
 * by the bulk sync and the webhooks. Already-imported orders stay.
 */
export function ImportHistoryToggle({
  provider,
  checked,
  cutoff,
}: {
  provider: "WOOCOMMERCE" | "SHOPIFY";
  checked: boolean;
  cutoff: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const cutoffDate = cutoff ? new Date(cutoff) : null;

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-hairline px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">Importer l&apos;historique des commandes</p>
        <p className="text-xs text-muted-foreground">
          Désactivé : « Synchroniser les commandes » n&apos;importe que les commandes passées après la désactivation
          {!checked && cutoffDate && !Number.isNaN(cutoffDate.getTime()) ? ` (${formatDateTime(cutoffDate)})` : ""}. Les
          nouvelles commandes continuent d&apos;arriver (synchronisation et webhooks) ; les commandes déjà importées
          restent.
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={isPending}
        aria-label="Importer l'historique des commandes"
        onCheckedChange={(next) => {
          startTransition(async () => {
            const result = await ACTIONS[provider](next);
            if (result.ok) {
              toast.success(next ? "L'historique sera importé aux prochaines synchronisations." : "Historique ignoré : seules les nouvelles commandes seront importées.");
              router.refresh();
            } else {
              toast.error(result.error);
            }
          });
        }}
      />
    </div>
  );
}
