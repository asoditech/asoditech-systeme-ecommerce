"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { checkWooCommerceRemoteProductAction, unlinkWooCommerceProductAction } from "@/actions/remote-product-links";
import { formatDateTime } from "@/lib/format";

type Check = "deleted" | "trashed" | "exists" | "unknown";

const FLAG_REASON: Record<Exclude<Check, "exists">, string> = {
  deleted: "La boutique confirme que ce produit n'existe plus.",
  trashed: "Ce produit est dans la corbeille de la boutique (il peut encore y être restauré).",
  unknown: "La boutique a signalé sa suppression, mais elle n'a pas pu être vérifiée.",
};

const CHECK_TOAST: Record<string, string> = {
  exists: "Le produit existe toujours sur la boutique : il reste lié.",
  unlinked: "Supprimé de la boutique : le produit a été dissocié automatiquement.",
  flagged: "Le produit n'est plus disponible sur la boutique : confirmez la dissociation.",
  already_flagged: "Le produit n'est toujours pas disponible sur la boutique.",
  unchanged: "Le produit n'est déjà plus lié.",
  unknown: "Impossible de joindre la boutique pour le moment — réessayez plus tard.",
};

function CheckButton({ productId, label }: { productId: string; label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const res = await checkWooCommerceRemoteProductAction({ productId });
          if (!res.ok) toast.error(res.error);
          else (res.data.result === "unknown" ? toast.error : toast.success)(CHECK_TOAST[res.data.result]);
          router.refresh();
        })
      }
    >
      <RefreshCw className="size-3.5" />
      {isPending ? "Vérification…" : label}
    </Button>
  );
}

/**
 * The product's WooCommerce link (src/lib/integrations/woocommerce/remote-deletion.ts),
 * for users who may publish (products.edit + integrations.manage).
 * - `flag` set: the store deleted it — what is known, and the confirmed
 *   « Dissocier » (the product, its stock and history stay);
 * - otherwise: a quiet « Vérifier sur la boutique ».
 */
export function RemoteLinkPanel({
  productId,
  externalId,
  kind,
  flag,
}: {
  productId: string;
  externalId: string;
  kind: "imported" | "publication";
  flag: { check: Check; detectedAt: string } | null;
}) {
  const linkLabel = kind === "imported" ? "importé de WooCommerce" : "publié sur WooCommerce";

  if (!flag || flag.check === "exists") {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Produit {linkLabel} (#{externalId}). Supprimé de la boutique ? Vérifiez-le ici.
          </p>
          <CheckButton productId={productId} label="Vérifier sur la boutique" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-amber-900 dark:text-amber-200">
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        Produit supprimé de la boutique WooCommerce (#{externalId})
      </p>
      <p className="mt-1 pl-6">
        {FLAG_REASON[flag.check]} Signalé le {formatDateTime(new Date(flag.detectedAt))}. Le produit, ses variantes, son stock, ses mouvements et ses
        commandes restent dans ASODITECH ; dissocier retire seulement le lien avec la boutique — vous pourrez le republier ensuite.
      </p>
      <div className="mt-3 flex flex-wrap gap-2 pl-6">
        <ConfirmActionButton
          label="Dissocier de WooCommerce"
          title="Dissocier ce produit de WooCommerce ?"
          description={`Le lien avec le produit WooCommerce #${externalId} sera retiré. Le produit ASODITECH, son stock et son historique sont conservés ; rien n'est supprimé sur la boutique. La boutique est vérifiée une dernière fois : un produit qu'elle possède encore n'est jamais dissocié.`}
          hiddenFields={{ productId }}
          action={(formData) => unlinkWooCommerceProductAction({ productId: formData.get("productId") })}
          successMessage="Produit dissocié de WooCommerce."
        />
        <CheckButton productId={productId} label="Vérifier à nouveau" />
      </div>
    </div>
  );
}
