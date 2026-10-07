"use client";

import { ArrowLeftRight, BadgePercent, Inbox, PackageCheck, Truck } from "lucide-react";
import {
  updateDefaultShippingProviderAction,
  updatePackingVerificationAction,
  updateSellerPriceOverrideAction,
  updateTransferCostOverrideAction,
} from "@/actions/settings";
import { setWooCommerceForceNouvelleOnImportAction } from "@/actions/woocommerce";
import { setShopifyForceNouvelleOnImportAction } from "@/actions/shopify";
import { ChoiceCard, formSwitch, ToggleTile, ValueTile } from "@/components/settings/setting-controls";

/**
 * The company-wide switches, the shop-import switches and the default
 * carrier, as tiles of the Configuration control center. Each saves through
 * its EXISTING server action (same field name, same permission checks, same
 * audit) — only the presentation changed.
 */

/**
 * « Autoriser les vendeurs magasin à modifier le prix » — company-wide.
 * Enforced on the server through effective access (`sales.override_price`);
 * a per-user DENY set in Utilisateurs still wins.
 */
export function SellerPriceOverrideForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="prix-vendeurs"
      section="magasin"
      icon={BadgePercent}
      title="Prix modifiable par les vendeurs"
      summary="Les vendeurs peuvent changer le prix ou accorder une remise à la caisse."
      detail="Désactivé : seuls un responsable ou un vendeur ayant le droit « modifier le prix » le peuvent."
      note="Un retrait dans Utilisateurs reste prioritaire."
      checked={enabled}
      save={formSwitch(updateSellerPriceOverrideAction, "allowSellerPriceOverride")}
      onMessage="Les vendeurs magasin peuvent modifier le prix."
      offMessage="Prix magasin : réservé aux responsables."
    />
  );
}

/**
 * « Vérification de l'emballage obligatoire » — when on, an online order can
 * only be shipped once its packing was verified (scan, or manual fallback).
 * Enforced on the server; off = today's behaviour.
 */
export function PackingVerificationForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="emballage"
      section="expedition"
      icon={PackageCheck}
      title="Vérification avant expédition"
      summary="Chaque article est scanné à l'étape « Emballage » avant que la commande puisse partir."
      detail="Une commande n'apparaît dans « À expédier » qu'une fois vérifiée. Désactivé : expédition sans vérification."
      note="Sans effet sur les commandes déjà expédiées."
      checked={enabled}
      save={formSwitch(updatePackingVerificationAction, "packingVerificationRequired")}
      onMessage="Vérification de l'emballage activée."
      offMessage="Vérification de l'emballage désactivée."
    />
  );
}

/**
 * « Coût d'achat lors des transferts » — when on, users with access to the
 * financial data can give a transfer line a purchase cost for the destination
 * location. Off = transfers move quantities only; costs already recorded on
 * locations are kept either way. Never a selling price.
 */
export function TransferCostOverrideForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="cout-transferts"
      section="stock"
      icon={ArrowLeftRight}
      title="Coût d'achat lors des transferts"
      summary="Définir un coût d'achat propre à l'emplacement de destination d'un transfert."
      detail="Les réceptions fournisseur mettent aussi à jour le coût de l'emplacement qui reçoit. Désactivé : les coûts déjà enregistrés sont conservés. Le prix de vente n'est jamais modifié."
      note="Réservé aux utilisateurs ayant accès aux données financières."
      checked={enabled}
      save={formSwitch(updateTransferCostOverrideAction, "transferPurchaseCostOverrideEnabled")}
      onMessage="Coût d'achat à destination activé pour les transferts."
      offMessage="Coût d'achat à destination désactivé — les coûts enregistrés sont conservés."
    />
  );
}

const IMPORT_ACTIONS = {
  WOOCOMMERCE: setWooCommerceForceNouvelleOnImportAction,
  SHOPIFY: setShopifyForceNouvelleOnImportAction,
} as const;

/**
 * « Toujours importer en Nouvelle » for one connected shop — the existing
 * per-integration action (integrations.manage). Only the orders imported from
 * now on are affected.
 */
export function ImportAsNouvelleTile({ provider, label, enabled }: { provider: "WOOCOMMERCE" | "SHOPIFY"; label: string; enabled: boolean }) {
  return (
    <ToggleTile
      anchor={`import-${provider.toLowerCase()}`}
      section="commandes"
      icon={Inbox}
      title={`${label} : importer en « Nouvelle »`}
      summary="Une commande importée reste « Nouvelle », jamais auto-confirmée — l'équipe appelle toujours le client."
      detail="Désactivé : le statut de la boutique est repris tel quel (une commande payée arrive « Confirmée »)."
      note="Les commandes déjà importées ne changent pas."
      checked={enabled}
      save={(next) => IMPORT_ACTIONS[provider](next)}
      onMessage="Activé : les nouvelles commandes arriveront en « Nouvelle »."
      offMessage="Désactivé."
    />
  );
}

/**
 * « Transporteur par défaut » — only decides whose city list is suggested on
 * the online order/customer forms when several delivery companies are active.
 */
export function DefaultShippingProviderForm({
  providers,
  defaultProviderId,
}: {
  providers: { id: string; name: string; hasCityList: boolean }[];
  defaultProviderId: string | null;
}) {
  const current = providers.find((p) => p.id === defaultProviderId);
  const explanation =
    providers.length === 0
      ? "Aucun transporteur actif : la ville est saisie librement."
      : providers.length === 1
        ? "Un seul transporteur actif : sa liste de villes est utilisée automatiquement."
        : "Plusieurs transporteurs actifs : sans choix, la ville est saisie librement.";
  return (
    <ValueTile
      anchor="transporteur"
      section="expedition"
      icon={Truck}
      title="Transporteur par défaut"
      summary="Propose sa liste de villes lors de la saisie d'une commande ou d'un client en ligne."
      value={current?.name ?? (defaultProviderId ? "Plus actif" : "Aucun")}
      valueCaption={explanation}
      note="Le transporteur réel reste choisi à la création de l'expédition."
      action={updateDefaultShippingProviderAction}
      success="Transporteur par défaut enregistré."
    >
      <div role="radiogroup" aria-label="Transporteur par défaut" className="grid gap-2 sm:grid-cols-2">
        <ChoiceCard name="defaultShippingProviderId" value="" defaultChecked={!current} title="Aucun" description="Saisie libre de la ville" />
        {providers.map((p) => (
          <ChoiceCard
            key={p.id}
            name="defaultShippingProviderId"
            value={p.id}
            defaultChecked={p.id === defaultProviderId}
            title={p.name}
            description={p.hasCityList ? "Liste de villes du transporteur" : "Sans liste de villes"}
          />
        ))}
      </div>
    </ValueTile>
  );
}
