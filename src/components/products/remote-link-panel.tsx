"use client";

import { useTransition } from "react";
import { Notice } from "@/components/ui/notice";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CircleHelp, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import {
  changeRemoteListingAction,
  checkRemoteProductAction,
  reconcileRemoteListingAction,
  unlinkRemoteProductAction,
} from "@/actions/remote-product-links";
import { formatDateTime } from "@/lib/format";
import { PROVIDER_LABEL, REMOTE_OPERATION_SUPPORT, remoteIdLabel, type RemoteProvider } from "@/lib/integrations/shared/remote-product-labels";

type Check = "deleted" | "trashed" | "exists" | "unknown";
type Listing = "live" | "withdrawn" | "missing";

export interface RemoteListingView {
  phase: "idle" | "in_progress" | "uncertain";
  listing: Listing | null;
  op: "withdraw" | "republish" | null;
  since: string | null;
  lastFailure: string | null;
}

const FLAG_REASON: Record<Exclude<Check, "exists">, (label: string) => string> = {
  deleted: (label) => `${label} confirme que ce produit n'existe plus.`,
  trashed: () => "Ce produit est dans la corbeille de la boutique (il peut encore y être restauré).",
  unknown: () => "La boutique a signalé sa suppression, mais elle n'a pas pu être vérifiée.",
};

const CHECK_TOAST: Record<string, string> = {
  exists: "Le produit existe toujours sur la boutique : il reste lié.",
  unlinked: "Supprimé de la boutique : le produit a été dissocié automatiquement.",
  flagged: "Le produit n'est plus disponible sur la boutique : confirmez la dissociation.",
  already_flagged: "Le produit n'est toujours pas disponible sur la boutique.",
  unchanged: "Le produit n'est déjà plus lié.",
  unknown: "Impossible de joindre la boutique pour le moment — réessayez plus tard.",
};

const LISTING_LABEL: Record<Listing, string> = {
  live: "en vente",
  withdrawn: "retiré de la vente",
  missing: "introuvable (supprimé ou à la corbeille)",
};

function useRunner() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return {
    isPending,
    run: (job: () => Promise<void>) =>
      startTransition(async () => {
        await job();
        router.refresh();
      }),
  };
}

function CheckButton({ productId, provider, label }: { productId: string; provider: RemoteProvider; label: string }) {
  const { isPending, run } = useRunner();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() =>
        run(async () => {
          const res = await checkRemoteProductAction({ productId, provider });
          if (!res.ok) toast.error(res.error);
          else (res.data.result === "unknown" ? toast.error : toast.success)(CHECK_TOAST[res.data.result]);
        })
      }
    >
      <RefreshCw className="size-3.5" />
      {isPending ? "Vérification…" : label}
    </Button>
  );
}

function ReconcileButton({ productId, provider }: { productId: string; provider: RemoteProvider }) {
  const { isPending, run } = useRunner();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() =>
        run(async () => {
          const res = await reconcileRemoteListingAction({ productId, provider });
          if (!res.ok) toast.error(res.error);
          else toast.success(`État vérifié : le produit est ${LISTING_LABEL[res.data.listing]} sur ${PROVIDER_LABEL[provider]}.`);
        })
      }
    >
      <RefreshCw className="size-3.5" />
      {isPending ? "Vérification…" : "Vérifier l'état sur la boutique"}
    </Button>
  );
}

/**
 * What ASODITECH can do to this product on the store, and what happens here
 * (src/lib/integrations/shared/remote-listing.ts). Shown only for a link
 * ASODITECH published or claimed; an imported product is the store's own.
 */
export function RemoteOperations({
  productId,
  provider,
  externalId,
  listing,
}: {
  productId: string;
  provider: RemoteProvider;
  externalId: string;
  listing: RemoteListingView;
}) {
  const label = PROVIDER_LABEL[provider];
  const support = REMOTE_OPERATION_SUPPORT[provider];
  const id = remoteIdLabel(provider, externalId);
  const withdrawn = listing.listing === "withdrawn";
  const busy = listing.phase !== "idle";

  return (
    <div className="space-y-2 border-t border-hairline pt-3 text-xs text-muted-foreground">
      <p className="text-sm font-medium text-foreground">Opérations sur la boutique {label}</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <span className="font-medium text-foreground">Retirer de la vente</span> : {support.withdraw.label.toLowerCase()} sur {label} (réversible).{" "}
          {support.localEffect}
        </li>
        <li>
          <span className="font-medium text-foreground">Suppression définitive</span> : {support.permanentDeletion}
        </li>
        <li>
          <span className="font-medium text-foreground">Suppression faite sur la boutique</span> : {support.inboundDeletion}
        </li>
      </ul>
      <p>
        Dernier état confirmé : {listing.listing ? LISTING_LABEL[listing.listing] : "non vérifié depuis ASODITECH"}
        {listing.since && listing.phase === "idle" && listing.listing ? ` (le ${formatDateTime(new Date(listing.since))})` : ""}.
      </p>

      {listing.phase === "uncertain" && (
        <Notice tone="warning" role="status">
          <CircleHelp aria-hidden="true" />
          <div>
            <p className="font-medium">À vérifier</p>
            <p>
              La demande « {listing.op === "republish" ? "Remettre en vente" : "Retirer de la boutique"} »
              {listing.since ? ` du ${formatDateTime(new Date(listing.since))}` : ""} n&apos;a pas reçu de réponse claire de {label} : elle a peut-être été
              appliquée. Rien n&apos;est renvoyé automatiquement. Vérifiez l&apos;état sur la boutique avant toute nouvelle demande.
            </p>
          </div>
        </Notice>
      )}
      {listing.phase === "in_progress" && (
        <Notice tone="info" role="status">
          <RefreshCw aria-hidden="true" />
          <p>Une demande est en cours d&apos;envoi à {label}. Rechargez la page dans quelques instants.</p>
        </Notice>
      )}

      <div className="flex flex-wrap gap-2">
        {withdrawn ? (
          <ConfirmActionButton
            label="Remettre en vente"
            title={`Remettre ce produit en vente sur ${label} ?`}
            description={`Le produit ${label} ${id} passera au statut « ${support.republish.remoteStatus} ». L'état actuel est relu sur la boutique avant l'envoi ; une seule demande est envoyée. Rien n'est supprimé ni modifié dans l'historique ASODITECH.`}
            hiddenFields={{ productId, provider, op: "republish" }}
            action={(formData) => changeRemoteListingAction({ productId: formData.get("productId"), provider: formData.get("provider"), op: formData.get("op") })}
            successMessage={`Produit remis en vente sur ${label}.`}
            disabled={busy}
          />
        ) : (
          <ConfirmActionButton
            label="Retirer de la boutique"
            title={`Retirer ce produit de la vente sur ${label} ?`}
            description={`${support.withdraw.label} du produit ${label} ${id} (statut « ${support.withdraw.remoteStatus} ») : il n'est plus visible par vos clients mais reste dans ${label}, et vous pourrez le remettre en vente. Aucune suppression définitive. ${support.localEffect} L'état actuel est relu avant l'envoi ; une seule demande est envoyée.`}
            hiddenFields={{ productId, provider, op: "withdraw" }}
            action={(formData) => changeRemoteListingAction({ productId: formData.get("productId"), provider: formData.get("provider"), op: formData.get("op") })}
            successMessage={`Produit retiré de la vente sur ${label}.`}
            disabled={busy}
          />
        )}
        <ReconcileButton productId={productId} provider={provider} />
      </div>
    </div>
  );
}

/**
 * The product's link to one connected store (WooCommerce or Shopify), for
 * users who may publish (products.edit + integrations.manage):
 * - `flag` set: the store deleted it — what is known, and the confirmed
 *   « Dissocier » (the product, its stock and history stay);
 * - otherwise: « Vérifier sur la boutique », plus — for a product ASODITECH
 *   published — the soft « Retirer de la boutique » / « Remettre en vente ».
 */
export function RemoteLinkPanel({
  productId,
  provider = "WOOCOMMERCE",
  externalId,
  kind,
  flag,
  listing = null,
}: {
  productId: string;
  provider?: RemoteProvider;
  externalId: string;
  kind: "imported" | "publication";
  flag: { check: Check; detectedAt: string } | null;
  /** Outbound state; null = no outbound operation offered for this link (a product created on the store). */
  listing?: RemoteListingView | null;
}) {
  const label = PROVIDER_LABEL[provider];
  const id = remoteIdLabel(provider, externalId);
  const linkLabel = kind === "imported" ? `importé de ${label}` : `publié sur ${label}`;

  if (!flag || flag.check === "exists") {
    return (
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Produit {linkLabel} ({id}). Supprimé de la boutique ? Vérifiez-le ici.
            </p>
            <CheckButton productId={productId} provider={provider} label="Vérifier sur la boutique" />
          </div>
          {listing && <RemoteOperations productId={productId} provider={provider} externalId={externalId} listing={listing} />}
        </CardContent>
      </Card>
    );
  }

  return (
    <Notice tone="warning" role="status">
      <div>
        <p className="flex items-start gap-2 font-medium">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Produit supprimé de la boutique {label} ({id})
        </p>
        <p className="mt-1 pl-6">
          {FLAG_REASON[flag.check](label)} Signalé le {formatDateTime(new Date(flag.detectedAt))}. Le produit, ses variantes, son stock, ses mouvements et
          ses commandes restent dans ASODITECH ; dissocier retire seulement le lien avec la boutique — vous pourrez le republier ensuite.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          <ConfirmActionButton
            label={`Dissocier de ${label}`}
            title={`Dissocier ce produit de ${label} ?`}
            description={`Le lien avec le produit ${label} ${id} sera retiré. Le produit ASODITECH, son stock et son historique sont conservés ; rien n'est supprimé sur la boutique. La boutique est vérifiée une dernière fois : un produit qu'elle possède encore n'est jamais dissocié.`}
            hiddenFields={{ productId, provider }}
            action={(formData) => unlinkRemoteProductAction({ productId: formData.get("productId"), provider: formData.get("provider") })}
            successMessage={`Produit dissocié de ${label}.`}
          />
          <CheckButton productId={productId} provider={provider} label="Vérifier à nouveau" />
        </div>
      </div>
    </Notice>
  );
}
