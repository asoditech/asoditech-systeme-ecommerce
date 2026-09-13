"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { setWooCommerceForceNouvelleOnImportAction } from "@/actions/woocommerce";
import { setShopifyForceNouvelleOnImportAction } from "@/actions/shopify";

const ACTIONS = {
  WOOCOMMERCE: setWooCommerceForceNouvelleOnImportAction,
  SHOPIFY: setShopifyForceNouvelleOnImportAction,
} as const;

/**
 * The intended ASODITECH workflow (docs/adr/0030's 2026-09-13 addendum):
 * every store order imported for the first time lands as "Nouvelle" here,
 * never auto-confirmed, so the confirmation team always calls the
 * customer before an order counts as confirmed — even for a store status
 * (WooCommerce "processing", a paid Shopify order) that would otherwise
 * map straight to "Confirmée". ON by default; this switch is an opt-OUT
 * for a tenant that genuinely wants to trust the store's own status
 * directly. Toggling never touches orders already imported, only ones
 * imported from this point on.
 */
export function ForceNouvelleToggle({
  provider,
  checked,
}: {
  provider: "WOOCOMMERCE" | "SHOPIFY";
  checked: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">Toujours importer en « Nouvelle »</p>
        <p className="text-xs text-muted-foreground">
          Une commande importée pour la première fois reste « Nouvelle » (jamais auto-confirmée), même si la
          boutique la considère déjà payée/confirmée — l&apos;équipe de confirmation appelle toujours le client.
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={isPending}
        onCheckedChange={(next) => {
          startTransition(async () => {
            const result = await ACTIONS[provider](next);
            if (result.ok) {
              toast.success(next ? "Activé : les nouvelles commandes arriveront en « Nouvelle »." : "Désactivé.");
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
