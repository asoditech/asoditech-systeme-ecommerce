import type { AnalyticsSection } from "@/lib/analytics/access";

/**
 * Metric definitions shown under every analytics section (« Définitions ») —
 * the in-app mirror of docs/analytics/metric-definitions.md. Each names its
 * population, its date field, its formula, its exclusions and its permission,
 * so every figure on screen is traceable to business events.
 */
export interface MetricDefinition {
  name: string;
  population: string;
  date: string;
  formula: string;
  exclusions?: string;
  permission: string;
}

const ONLINE = "analytics.view + un canal En ligne";
const COHORT = "Commandes en ligne passées sur la période";

export const METRIC_DEFINITIONS: Record<AnalyticsSection, MetricDefinition[]> = {
  overview: [
    { name: "Commandes", population: COHORT, date: "placedAt (date de la commande chez le client / la boutique)", formula: "Nombre de commandes", permission: ONLINE },
    { name: "Confirmées", population: COHORT, date: "placedAt", formula: "Commandes ayant atteint la confirmation : statut Confirmée ou ultérieur (y compris Échec, Retour, Remboursée), ou confirmedAt renseigné", exclusions: "Une commande rouverte (confirmation effacée, ADR 0049) redevient non confirmée", permission: ONLINE },
    { name: "Taux de confirmation", population: COHORT, date: "placedAt", formula: "Confirmées ÷ Commandes", exclusions: "Les commandes encore « Nouvelle » restent dans le dénominateur (affichées à part)", permission: ONLINE },
    { name: "Livrées / Annulées / Échecs / Retournées", population: COHORT, date: "placedAt", formula: "Statut ACTUEL de la commande (Retournées = Retour + Remboursée)", permission: ONLINE },
    { name: "Taux de livraison (cohorte)", population: "Commandes de la cohorte expédiées (statut Expédiée ou ultérieur, ou shippedAt renseigné)", date: "placedAt", formula: "Livrées ÷ Expédiées", permission: ONLINE },
    { name: "CA commandé", population: COHORT, date: "placedAt", formula: "Somme des totaux de commande", exclusions: "Annulée, Échec, Retour, Remboursée (même règle que Finance et le rapport Ventes)", permission: ONLINE },
    { name: "CA livré", population: COHORT, date: "placedAt", formula: "Somme des totaux des commandes au statut Livrée", permission: ONLINE },
    { name: "Panier moyen", population: "Commandes comptées dans le CA commandé", date: "placedAt", formula: "CA commandé ÷ nombre de ces commandes", permission: ONLINE },
    { name: "Unités vendues", population: "Lignes des commandes comptées dans le CA commandé", date: "placedAt", formula: "Somme des quantités", permission: ONLINE },
    { name: "Remboursé", population: "Remboursements « Complété » des commandes de la cohorte", date: "placedAt de la commande (règle d'attribution de Finance)", formula: "Somme des montants", permission: ONLINE },
    { name: "Ventes magasin", population: "Ventes en magasin (POS) des magasins et emplacements de l'utilisateur", date: "soldAt", formula: "Brut = somme des totaux ; Net = brut − remboursements des retours reçus sur la période (receivedAt)", exclusions: "Jamais mélangées aux commandes en ligne", permission: "analytics.view + un canal Magasin" },
    { name: "Commissions", population: "Écritures du registre de commissions", date: "createdAt de l'écriture (date de l'événement)", formula: "Gagnées (EARNED) − annulées (REVERSED) = nettes", permission: "analytics.view + commissions.view" },
    { name: "Coût, marge, bénéfice", population: "Comme la page Finance", date: "placedAt", formula: "Voir Finance (ADR 0007)", exclusions: "Jamais calculés sans finance.view", permission: "analytics.view + finance.view" },
  ],
  confirmation: [
    { name: "Entrées dans la confirmation", population: COHORT, date: "placedAt", formula: "Nombre de commandes", exclusions: "Inclut les commandes saisies « client déjà confirmé » (ADR 0046) et les importations", permission: ONLINE },
    { name: "Confirmées / Taux", population: COHORT, date: "placedAt", formula: "Voir Vue d'ensemble — Confirmées ÷ Entrées", permission: ONLINE },
    { name: "Tentatives", population: "Tentatives de confirmation enregistrées", date: "createdAt de la tentative", formula: "Nombre de tentatives, par résultat (Confirmé, Pas de réponse, Occupé, Rappeler, Faux numéro, Annulé)", permission: ONLINE },
    { name: "Délai de confirmation", population: "Commandes confirmées sur la période", date: "confirmedAt", formula: "confirmedAt − placedAt (moyenne et médiane)", exclusions: "Commandes sans horodatage exclues ; l'échantillon est affiché", permission: ONLINE },
    { name: "Confirmateur", population: "Tentatives de la période", date: "createdAt de la tentative", formula: "L'utilisateur qui a enregistré la tentative (jamais le créateur de la commande ni l'agent commissionné). Délai propre = date de sa tentative « Confirmé » − placedAt", exclusions: "Commandes confirmées sans tentative enregistrée (importations, historique) : comptées à part, attribuées à personne", permission: ONLINE },
  ],
  delivery: [
    { name: "Expédiées", population: "Commandes en ligne expédiées sur la période", date: "shippedAt (action Expédiée, ou colis passé En transit chez le transporteur)", formula: "Nombre de commandes", exclusions: "Commandes importées déjà livrées sans date d'expédition : absentes (aucune date à rattacher)", permission: ONLINE },
    { name: "Livrées / Échecs / Retournées / En cours", population: "Commandes expédiées sur la période", date: "shippedAt", formula: "Statut ACTUEL : Livrée ; Échec ou Annulée après échec ; Retour ou Remboursée ; sinon en cours", permission: ONLINE },
    { name: "Taux de livraison / d'échec / de retour", population: "Commandes expédiées sur la période", date: "shippedAt", formula: "Livrées, Échecs, Retournées ÷ Expédiées", permission: ONLINE },
    { name: "Délais", population: "Commandes expédiées sur la période portant les deux dates", date: "confirmedAt, shippedAt, deliveredAt", formula: "Confirmée → expédiée, expédiée → livrée, confirmée → livrée (livrées uniquement pour les deux derniers)", exclusions: "Jamais estimés : une date manquante exclut la commande du délai", permission: ONLINE },
    { name: "Transporteur", population: "Commandes expédiées sur la période", date: "shippedAt", formula: "Transporteur de la dernière expédition de la commande", exclusions: "Échecs de création API jamais remis au transporteur (ADR 0031)", permission: ONLINE },
  ],
  products: [
    { name: "Unités, commandes, CA (en ligne)", population: "Lignes des commandes passées sur la période comptées dans le CA", date: "placedAt", formula: "Somme des quantités, nombre de commandes distinctes, somme des totaux de ligne", exclusions: "Annulée, Échec, Retour, Remboursée", permission: ONLINE },
    { name: "Unités, ventes, CA (magasin)", population: "Lignes des ventes en magasin de vos magasins et emplacements", date: "soldAt", formula: "Mêmes sommes sur les lignes de vente", permission: "analytics.view + un canal Magasin" },
    { name: "Unités retournées", population: "Retours physiques reçus sur la période", date: "receivedAt du retour", formula: "Revendables + endommagées", exclusions: "Peut concerner une vente d'une période antérieure", permission: "Comme la ligne" },
    { name: "Coût, bénéfice brut", population: "Mêmes lignes", date: "Mêmes dates", formula: "Coût = Σ (coût figé à la vente × quantité) ; bénéfice brut = CA − coût", exclusions: "Non calculé si une ligne n'a pas de coût figé ; jamais calculé sans finance.view", permission: "finance.view" },
  ],
  commissions: [
    { name: "Gagnées", population: "Écritures EARNED", date: "createdAt de l'écriture (passage à Livrée)", formula: "Somme des montants (taux figé de l'agent au moment du gain)", permission: "analytics.view + commissions.view" },
    { name: "Annulées", population: "Écritures REVERSED", date: "createdAt de l'écriture (sortie de Livrée)", formula: "Somme des montants annulés", permission: "analytics.view + commissions.view" },
    { name: "Nettes", population: "Toutes les écritures de la période", date: "createdAt", formula: "Gagnées − annulées", exclusions: "Le registre n'est jamais recalculé : un agent désactivé conserve ses écritures", permission: "analytics.view + commissions.view" },
  ],
  sources: [
    { name: "Origine", population: COHORT, date: "placedAt", formula: "WooCommerce, Shopify, ou le canal saisi sur une commande manuelle (WhatsApp, Instagram, Téléphone, …) — même regroupement que la liste des commandes", permission: ONLINE },
    { name: "Entonnoir par origine", population: COHORT, date: "placedAt", formula: "Commandes → confirmées → expédiées → livrées (statut actuel)", permission: ONLINE },
    { name: "Magasin", population: "Ventes en magasin de vos magasins et emplacements", date: "soldAt", formula: "Ventes, CA brut par magasin et par emplacement — sans entonnoir (une vente n'est pas une commande en ligne)", permission: "analytics.view + un canal Magasin" },
  ],
};
