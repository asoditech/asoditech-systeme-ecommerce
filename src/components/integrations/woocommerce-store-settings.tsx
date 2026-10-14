"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { setWooCommerceInventoryOwnerAction, setWooCommerceRemoteDeletionModeAction } from "@/actions/woocommerce";
import { setShopifyInventoryOwnerAction } from "@/actions/shopify";
import type { InventoryOwner, RemoteDeletionMode } from "@/lib/integrations/woocommerce/store-settings";

interface Choice<T extends string> {
  value: T;
  label: string;
  description: string;
}

/** A per-connection choice between a few options — native radios (keyboard + screen readers), saved on change. */
function ChoiceSetting<T extends string>({
  title,
  note,
  choices,
  value,
  save,
  savedMessage,
}: {
  title: string;
  note: string;
  choices: Choice<T>[];
  value: T;
  save: (next: T) => Promise<{ ok: true } | { ok: false; error: string }>;
  savedMessage: (next: T) => string;
}) {
  const router = useRouter();
  const name = useId();
  const [current, setCurrent] = useState(value);
  const [isPending, startTransition] = useTransition();

  function choose(next: T) {
    if (next === current) return;
    const before = current;
    setCurrent(next);
    startTransition(async () => {
      const result = await save(next);
      if (result.ok) {
        toast.success(savedMessage(next));
        router.refresh();
      } else {
        setCurrent(before);
        toast.error(result.error);
      }
    });
  }

  return (
    <fieldset className="space-y-2 rounded-lg border border-hairline px-3 py-2.5" disabled={isPending}>
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-xl border px-2.5 py-2 text-xs transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring/40",
              current === choice.value ? "border-brand bg-pill-peach/40" : "border-hairline hover:bg-row-hover"
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={current === choice.value}
              onChange={() => choose(choice.value)}
              className="mt-0.5 accent-primary"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">{choice.label}</span>
              <span className="text-muted-foreground">{choice.description}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
    </fieldset>
  );
}

const DELETION_CHOICES: Choice<RemoteDeletionMode>[] = [
  {
    value: "manual",
    label: "Me demander avant de dissocier",
    description:
      "ASODITECH vous prévient (notification + fiche produit) et garde le lien jusqu'à ce qu'un utilisateur autorisé confirme la dissociation.",
  },
  {
    value: "auto",
    label: "Dissocier automatiquement",
    description:
      "Vous autorisez ASODITECH à retirer le lien sans vous demander, uniquement quand la boutique confirme que le produit n'existe plus. Une simple mise à la corbeille, une boutique injoignable ou une erreur ne dissocient jamais : le produit est alors signalé pour confirmation.",
  },
];

const OWNER_CHOICES: Choice<InventoryOwner>[] = [
  {
    value: "ASODITECH",
    label: "ASODITECH",
    description:
      "ASODITECH gère le stock : à l'import, un produit suivi par la boutique reçoit sa ligne de stock à la quantité qu'elle indique (aucune si elle n'en indique pas — jamais 0 par défaut), puis ASODITECH réserve, déstocke et envoie son stock à la boutique. « Suivre le stock » reste votre choix sur chaque fiche produit.",
  },
  {
    value: "STORE",
    label: "Ma boutique en ligne",
    description:
      "La boutique garde son propre stock : les produits importés ensuite ne reçoivent aucune ligne de stock dans ASODITECH, et ASODITECH n'envoie plus aucun stock à la boutique, pour aucun produit.",
  },
];

/**
 * Two independent per-connection settings of the WooCommerce card
 * (src/lib/integrations/woocommerce/store-settings.ts) — neither is
 * inferred from the other. Shown only to `integrations.manage`.
 */
export function WooCommerceStoreSettings({ remoteDeletionMode, inventoryOwner }: { remoteDeletionMode: RemoteDeletionMode; inventoryOwner: InventoryOwner }) {
  return (
    <>
      <ChoiceSetting
        title="Que faire lorsqu’un produit est supprimé de la boutique ?"
        note="Dans tous les cas, le produit ASODITECH, ses variantes, son stock, ses mouvements et ses commandes sont conservés : seul le lien avec la boutique est retiré. Vous pourrez le republier ou le relier à nouveau."
        choices={DELETION_CHOICES}
        value={remoteDeletionMode}
        save={setWooCommerceRemoteDeletionModeAction}
        savedMessage={(next) => (next === "auto" ? "Les produits supprimés de la boutique seront dissociés automatiquement." : "Vous confirmerez chaque dissociation.")}
      />
      <InventoryOwnerSetting value={inventoryOwner} save={setWooCommerceInventoryOwnerAction} />
    </>
  );
}

function InventoryOwnerSetting({ value, save }: { value: InventoryOwner; save: (next: InventoryOwner) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  return (
    <ChoiceSetting
      title="Qui gère le stock des produits importés ?"
      note="Changer ce choix ne supprime, ne remet à zéro et ne modifie aucun stock existant. Passer à la boutique : les stocks déjà enregistrés dans ASODITECH sont conservés mais ne sont plus envoyés. Revenir à ASODITECH : ces stocks seront de nouveau envoyés au prochain mouvement ou envoi — vérifiez-les d'abord."
      choices={OWNER_CHOICES}
      value={value}
      save={save}
      savedMessage={(next) => (next === "STORE" ? "Les prochains produits importés garderont le stock de la boutique." : "ASODITECH gérera le stock des prochains produits importés.")}
    />
  );
}

/** The Shopify card's stock-ownership choice — same setting and wording as WooCommerce's. */
export function ShopifyStoreSettings({ inventoryOwner }: { inventoryOwner: InventoryOwner }) {
  return <InventoryOwnerSetting value={inventoryOwner} save={setShopifyInventoryOwnerAction} />;
}
