import {
  averageBasket,
  confirmationRatePct,
  countOutcomes,
  deliveryOutcomeRate,
  netRevenue,
  orderDeliveryOutcome,
} from "@/lib/metrics/formulas";

/**
 * Plain-language explanation of each metric label — what it measures, how it
 * is calculated, and a small worked example — shown by the « ⓘ » popover on
 * KPI cards (src/components/metric-info.tsx) and mirrored in
 * docs/analytics/metric-definitions.md. Every example is COMPUTED with the
 * same functions the screens use (src/lib/metrics/formulas.ts), so it can't
 * contradict them. Pure and client-safe.
 */
export interface MetricExplanation {
  label: string;
  what: string;
  how: string;
  example: string;
  /** What the data can't tell (shown when present). */
  limit?: string;
}

const mad = (n: number) => `${n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MAD`;
const pct = (ratio: number | null) => (ratio === null ? "—" : `${(Math.round(ratio * 1000) / 10).toLocaleString("fr-FR")} %`);

function revenueExample(): string {
  const gross = 200 + 300 + 150;
  return `3 commandes de 200, 300 et 150 MAD (livraison facturée comprise) et une 4e annulée de 400 MAD ; 50 MAD remboursés sur l'une d'elles → ${mad(gross)} − ${mad(50)} = ${mad(netRevenue(gross, 50))}.`;
}

function deliveryExample(): string {
  const outcomes = countOutcomes([
    orderDeliveryOutcome("LIVREE", "LIVRE"),
    orderDeliveryOutcome("LIVREE", "LIVRE"),
    orderDeliveryOutcome("LIVREE", "LIVRE"),
    orderDeliveryOutcome("EXPEDIEE", "ECHEC"),
    orderDeliveryOutcome("EXPEDIEE", "EN_TRANSIT"),
  ]);
  return `5 commandes expédiées : 3 livrées, 1 en échec, 1 encore en route → 3 ÷ (3 + 1 + 0) = ${pct(deliveryOutcomeRate(outcomes))}. La commande en route ne compte pas encore ; une commande échouée puis livrée au 2e envoi compte comme livrée, une seule fois.`;
}

export const METRIC_GLOSSARY = {
  revenue: {
    label: "Chiffre d'affaires",
    what: "Ce que vous avez vendu sur la période, remboursements déduits.",
    how: "Somme des totaux des commandes passées sur la période (frais de livraison facturés au client compris, remises déduites), hors commandes annulées, en échec, retournées ou remboursées, moins les remboursements effectués sur ces commandes. Rattaché à la date de la commande.",
    example: revenueExample(),
    limit: "Un remboursement compte dans la période de la commande remboursée, même s'il a été fait plus tard.",
  },
  ordersPlaced: {
    label: "Commandes",
    what: "Le nombre de commandes reçues sur la période.",
    how: "Toutes les commandes passées sur la période, quel que soit leur statut (annulées comprises).",
    example: "8 commandes reçues dont 1 annulée → 8 commandes.",
  },
  averageBasket: {
    label: "Panier moyen",
    what: "La valeur moyenne d'une commande valide.",
    how: "Total des commandes valides (hors annulées, échecs, retours, remboursées) ÷ leur nombre. Les remboursements, plus tardifs, ne réduisent pas le panier.",
    example: `3 commandes valides de 200, 300 et 150 MAD → ${mad(averageBasket(650, 3) ?? 0)}.`,
  },
  confirmationRate: {
    label: "Taux de confirmation",
    what: "La part des commandes appelées qui ont été confirmées.",
    how: "Commandes confirmées ÷ commandes passées par la confirmation (au moins une tentative d'appel enregistrée, ou confirmées à l'import). Une commande jamais appelée reste « À confirmer » et n'entre pas dans le calcul ; une commande confirmée puis retournée reste confirmée.",
    example: `10 commandes appelées, 7 confirmées, 2 en attente jamais appelées → 7 ÷ 10 = ${confirmationRatePct(7, 10)} %.`,
  },
  confirmedThisMonth: {
    label: "Confirmées ce mois",
    what: "Le nombre de commandes confirmées depuis le 1er du mois.",
    how: "Commandes distinctes ayant une tentative « Confirmé » ce mois-ci (fuseau horaire de votre boutique). Une commande reconfirmée après réouverture compte une fois.",
    example: "3 appels le même jour sur une commande, dont 1 « Confirmé » → 1 commande confirmée.",
  },
  deliveryRate: {
    label: "Taux de livraison réussie",
    what: "La part des colis arrivés au bout qui ont été livrés.",
    how: "Commandes livrées ÷ (livrées + échecs + retours), une seule fois par commande, d'après sa dernière expédition ; un « Retour » / « Remboursée » enregistré sur la commande l'emporte sur un colis « Livré ». Les colis en route et les expéditions annulées n'ont pas encore (ou pas) de résultat.",
    example: deliveryExample(),
  },
  ordersShipped: {
    label: "Commandes expédiées",
    what: "Le nombre de commandes ayant une expédition créée sur la période.",
    how: "Une ligne par commande : sa dernière expédition. Les tentatives remplacées (annulées puis renvoyées) restent dans l'historique sans être recomptées.",
    example: "Un colis annulé puis renvoyé avec un autre transporteur → 1 commande expédiée (+1 tentative dans l'historique).",
  },
  refunded: {
    label: "Remboursé",
    what: "L'argent rendu aux clients.",
    how: "Somme des remboursements au statut « Complété » des commandes passées sur la période.",
    example: "Un remboursement partiel de 50 MAD sur une commande de 300 MAD → 50 MAD remboursés.",
  },
  newCustomers: {
    label: "Nouveaux clients",
    what: "Les clients qui ont acheté pour la première fois sur la période.",
    how: "Clients dont la toute première commande (tout l'historique) a été passée sur la période et qui ont une commande valide sur la période. La date d'import d'un client n'entre pas en compte.",
    example: "Un client importé de WooCommerce l'an dernier qui commande aujourd'hui pour la 1re fois → nouveau client.",
  },
  deliveryCost: {
    label: "Coût de livraison",
    what: "Ce que la livraison vous a coûté.",
    how: "Coûts enregistrés sur les expéditions des commandes passées sur la période (livraisons, retours, échecs, corrections manuelles), toutes tentatives comprises. Hors expéditions annulées et commandes annulées.",
    example: "Une commande échouée (20 MAD de frais d'échec) puis livrée au 2e envoi (35 MAD) → 55 MAD.",
  },
  lowStock: {
    label: "Produits en stock faible",
    what: "Les articles qui risquent la rupture.",
    how: "Lignes de stock (un article dans un emplacement actif) dont le stock disponible — physique moins réservé — est inférieur ou égal au seuil d'alerte du produit. Même règle que les alertes.",
    example: "Seuil 5, 8 en stock dont 4 réservés → 4 disponibles : stock faible.",
    limit: "Un article présent dans 2 emplacements compte 2 fois (une par emplacement).",
  },
  cashAwaiting: {
    label: "À encaisser",
    what: "L'argent attendu des commandes en cours.",
    how: "Totaux des commandes passées sur la période, encore « En attente » ou « Partiellement payé », hors commandes annulées, en échec, retournées ou remboursées.",
    example: "2 commandes COD en route de 200 et 300 MAD → 500 MAD à encaisser.",
    limit: "Le montant déjà payé d'une commande partiellement payée n'est pas enregistré : elle compte pour son total.",
  },
  productRevenue: {
    label: "CA produits",
    what: "Les ventes de produits, hors frais de livraison.",
    how: "Somme des totaux de ligne (prix × quantité, remise de ligne déduite) des commandes valides de la période. Ni les frais de livraison, ni les remises globales, ni les remboursements ne sont répartis par produit.",
    example: "2 articles à 100 MAD + 30 MAD de livraison → 200 MAD de CA produits (le chiffre d'affaires de la commande est 230 MAD).",
    limit: "Les remboursements sont enregistrés par commande, pas par produit : ils ne peuvent pas être déduits ici.",
  },
  commissionDue: {
    label: "Reste à payer",
    what: "Les commissions dues aux agents de confirmation.",
    how: "Pour chaque agent (actif ou non) : commissions gagnées − annulées − déjà payées, additionnées.",
    example: "Un agent : 300 MAD gagnés, 30 annulés, 200 payés → 70 MAD restants.",
    limit: "Les agents payés dans des devises différentes sont additionnés tels quels.",
  },
} satisfies Record<string, MetricExplanation>;

export type MetricKey = keyof typeof METRIC_GLOSSARY;
