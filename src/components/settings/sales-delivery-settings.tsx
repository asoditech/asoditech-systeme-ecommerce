"use client";

import { ArrowLeftRight, BadgePercent, Banknote, Barcode, HandCoins, Inbox, PackageCheck, Truck } from "lucide-react";
import {
  updateDefaultShippingProviderAction,
  updateAutoPaymentFromStoreAction,
  updateAutoPaidOnDeliveryAction,
  updateCustomerBarcodeSettingAction,
  updateProductBarcodeAutoAction,
  updatePackingVerificationAction,
  updateSellerPriceOverrideAction,
  updateTransferCostOverrideAction,
} from "@/actions/settings";
import { setWooCommerceForceNouvelleOnImportAction } from "@/actions/woocommerce";
import { setShopifyForceNouvelleOnImportAction } from "@/actions/shopify";
import { ChoiceCard, formSwitch, ToggleTile, ValueTile } from "@/components/settings/setting-controls";
import { SettingInfo } from "@/components/settings/setting-info";

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
      info={<SettingInfo setting="sellerPriceOverride" />}
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
      info={<SettingInfo setting="packingVerification" />}
    />
  );
}

/**
 * « Paiement confirmé par la boutique » — opt-in: an imported order the shop
 * reports as paid becomes « Payé ». Never driven by a carrier « Livré ».
 */
export function AutoPaymentFromStoreForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="paiement-boutique"
      section="commandes"
      icon={Banknote}
      title="Paiement confirmé par la boutique"
      summary="Une commande importée passe « Payé » quand WooCommerce ou Shopify la signale payée."
      detail="Désactivé (par défaut) : le statut de paiement se change à la main. Le paiement à la livraison (WooCommerce « cod ») n'est jamais considéré payé par la boutique."
      note="Seulement « En attente » → « Payé » ; chaque changement est historisé."
      checked={enabled}
      save={formSwitch(updateAutoPaymentFromStoreAction, "autoPaymentFromStore")}
      onMessage="Paiement confirmé par la boutique : activé."
      offMessage="Paiement confirmé par la boutique : désactivé."
      info={<SettingInfo setting="autoPaymentFromStore" />}
    />
  );
}

/** « Marquer automatiquement les commandes comme payées à la livraison » — this company only, default off. */
export function AutoPaidOnDeliveryForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="paiement-livraison"
      section="commandes"
      icon={HandCoins}
      title="Marquer automatiquement les commandes comme payées à la livraison"
      summary="Une commande « En attente » de paiement passe « Payé » dès qu'elle est livrée (colis « Livré », statut « Livrée » ou boutique)."
      detail="Désactivé (par défaut) : une livraison ne change jamais le paiement. Activé, c'est la règle de votre société « livré = payé » : aucun encaissement ni versement du transporteur n'est enregistré pour autant."
      note="Seulement « En attente » → « Payé », jamais « Échec » ; pas d'effet sur les commandes déjà livrées ; chaque changement est historisé."
      checked={enabled}
      save={formSwitch(updateAutoPaidOnDeliveryAction, "autoPaidOnDelivery")}
      onMessage="Paiement à la livraison : les commandes livrées passeront « Payé »."
      offMessage="Paiement à la livraison : désactivé."
      info={<SettingInfo setting="autoPaidOnDelivery" />}
    />
  );
}

/**
 * « Code-barres client automatique » (docs/adr/0060) — rendered only when the
 * platform granted the tenant; the server re-checks the grant.
 */
export function CustomerBarcodeForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="codes-clients"
      section="commandes"
      icon={Barcode}
      title="Code-barres client automatique"
      summary="Chaque nouveau client reçoit un code unique « CL-000001 », imprimable et lisible au scanner."
      detail="Les clients existants ne reçoivent pas de code automatiquement. Désactivé : les nouveaux clients n'ont pas de code ; les codes déjà attribués sont conservés."
      note="Réactiver reprend la numérotation là où elle s'était arrêtée : un code n'est jamais réutilisé."
      checked={enabled}
      save={formSwitch(updateCustomerBarcodeSettingAction, "customerBarcodeEnabled")}
      onMessage="Codes clients automatiques activés pour les nouveaux clients."
      offMessage="Codes clients automatiques désactivés — les codes existants sont conservés."
      info={<SettingInfo setting="customerBarcode" />}
    />
  );
}

/**
 * « Génération automatique des codes-barres produits » (docs/adr/0061) —
 * rendered only for tenants with barcodes (catalogIdentity).
 */
export function ProductBarcodeAutoForm({ enabled }: { enabled: boolean }) {
  return (
    <ToggleTile
      anchor="codes-barres-produits"
      section="stock"
      icon={Barcode}
      title="Génération automatique des codes-barres"
      summary="Un bouton « Générer » à côté du code-barres d'un produit et de chaque variation, et un code distinct pour chaque nouvelle variation."
      detail="Code interne de 13 chiffres commençant par « 20 » (numéro réservé à usage interne GS1, pas un EAN commercial). Désactivé : saisie manuelle uniquement, comme avant."
      note="Un code déjà saisi n'est jamais remplacé sans confirmation ; aucun produit existant ne reçoit de code automatiquement."
      checked={enabled}
      save={formSwitch(updateProductBarcodeAutoAction, "productBarcodeAutoEnabled")}
      onMessage="Génération automatique des codes-barres activée."
      offMessage="Génération automatique désactivée — la saisie manuelle reste possible."
      info={<SettingInfo setting="productBarcodeAuto" />}
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
      info={<SettingInfo setting="transferCostOverride" />}
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
      info={<SettingInfo setting="importAsNouvelle" label={`${label} : importer en « Nouvelle »`} />}
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
      info={<SettingInfo setting="defaultShippingProvider" />}
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
