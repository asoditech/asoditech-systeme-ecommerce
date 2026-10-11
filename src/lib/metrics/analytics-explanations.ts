import type { AnalyticsSection } from "@/lib/analytics/access";
import { formatHours } from "@/lib/analytics/format";
import {
  EXAMPLE,
  EXAMPLE_ATTEMPTS,
  EXAMPLE_ATTEMPTS_TOTAL,
  EXAMPLE_COMMISSION,
  EXAMPLE_DURATIONS,
  EXAMPLE_STORE,
} from "@/lib/metrics/example-dataset";
import { averageBasket } from "@/lib/metrics/formulas";

/**
 * Explanations of EVERY figure shown by /analyses (six tabs) — the single
 * registry behind the « ⓘ » popovers and the « Définitions des indicateurs »
 * panel of each tab. Explanation text only: nothing here is read by a query,
 * an export or a permission check, and the language (fr / ar) never changes
 * a value.
 *
 * Each entry describes what the code ACTUALLY computes (source given in
 * `source`), audited against src/lib/analytics/queries/*.ts. Worked examples
 * come from ONE fictional shop (src/lib/metrics/example-dataset.ts), computed
 * with the same formula functions as the screens. `bi()` makes the Arabic
 * text carry exactly the same sections as the French one, so a metric cannot
 * be added in one language only.
 */

export type ExplanationLang = "fr" | "ar";

export interface MetricText {
  /** Définition — what the figure represents. */
  definition: string;
  /** Calcul — the formula implemented. */
  calculation: string;
  /** Exemple — worked example on the fictional dataset. */
  example: string;
  /** Périmètre — records included / excluded. */
  scope?: string;
  /** Période — the date field that places a record in the period. */
  period?: string;
  /** Filtres — how the page filters change it. */
  filters?: string;
  /** Interprétation — what it means and does not mean. */
  interpretation?: string;
  /** Précautions — limits and common misreadings. */
  caveats?: string;
}

/**
 * One explained item — a figure, a column, a setting. Shared by every
 * registry: /analyses (here), /rapports (src/lib/metrics/report-
 * explanations.ts) and /parametres (src/lib/settings/settings-
 * explanations.ts).
 */
export interface ExplanationDoc {
  /** Exact UI label(s) where the item is displayed (unchanged, French). */
  labels: readonly string[];
  /** Where it is computed / stored. */
  source: string;
  /** Who may see it (technical permission names). */
  access: string;
  text: Record<ExplanationLang, MetricText>;
}

export interface AnalyticsMetricDoc extends ExplanationDoc {
  /** Tabs that display it. */
  sections: readonly AnalyticsSection[];
}

/** The Arabic text must carry exactly the French sections. */
export function bi<T extends MetricText>(fr: T, ar: { [K in keyof T]-?: string }): Record<ExplanationLang, MetricText> {
  return { fr, ar: ar as MetricText };
}

export const SECTION_TITLES: Record<keyof MetricText, Record<ExplanationLang, string>> = {
  definition: { fr: "Définition", ar: "التعريف" },
  calculation: { fr: "Calcul", ar: "طريقة الحساب" },
  scope: { fr: "Périmètre", ar: "نطاق الحساب" },
  period: { fr: "Période", ar: "الفترة الزمنية" },
  filters: { fr: "Filtres", ar: "الفلاتر" },
  example: { fr: "Exemple", ar: "مثال" },
  interpretation: { fr: "Interprétation", ar: "كيف نفهم النتيجة" },
  caveats: { fr: "Précautions", ar: "ملاحظات مهمة" },
};

/** Display order of the sections (full explanation). */
export const SECTION_ORDER: (keyof MetricText)[] = ["definition", "calculation", "scope", "period", "filters", "example", "interpretation", "caveats"];

// ---------------------------------------------------------------------------
// Number formatting (identical in both languages: Western digits, MAD)
// ---------------------------------------------------------------------------

const nf = (n: number, d = 2) => n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: d }).replace(/ /g, " ");
const mad = (n: number) => `${nf(n)} MAD`;
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1).replace(".", ",")} %`);
const E = EXAMPLE;
const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: readonly number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const sac = E.products.find((p) => p.product === "Sac Atlas")!;
const storeGross = EXAMPLE_STORE.sales.reduce((a, b) => a + b, 0);
const commissionEarned = EXAMPLE_COMMISSION.ratePerOrder * EXAMPLE_COMMISSION.earnedEntries;
const commissionReversed = EXAMPLE_COMMISSION.ratePerOrder * EXAMPLE_COMMISSION.reversedEntries;

// ---------------------------------------------------------------------------
// Shared snippets
// ---------------------------------------------------------------------------

const ONLINE = "analytics.view + un canal En ligne";
const STORE = "analytics.view + un canal Magasin (vos magasins et emplacements)";
const COMMISSIONS = "analytics.view + commissions.view";
const FINANCE = "analytics.view + finance.view";

const PLACED = {
  fr: "Date de la commande (placedAt) comprise dans la période, premier et dernier jour inclus, jours découpés dans le fuseau horaire de la boutique (Africa/Casablanca par défaut).",
  ar: "تاريخ الطلب (placedAt) داخل الفترة المختارة، مع احتساب اليوم الأول والأخير، وتُحدَّد الأيام حسب المنطقة الزمنية للمتجر (Africa/Casablanca افتراضيًا).",
};
const SHIPPED_AT = {
  fr: "Date d'expédition de la commande (shippedAt : passage à « Expédiée », ou colis passé « En transit » chez le transporteur), premier et dernier jour inclus, fuseau horaire de la boutique.",
  ar: "تاريخ شحن الطلب (shippedAt: الانتقال إلى « Expédiée » أو انتقال الطرد إلى « En transit » لدى شركة التوصيل)، مع احتساب اليوم الأول والأخير، حسب المنطقة الزمنية للمتجر.",
};
const ORIGIN_FILTER = {
  fr: "« Origine » (WooCommerce, Shopify, ou le canal saisi sur une commande manuelle) et, si vous avez plusieurs boutiques en ligne, « Canal » ne gardent que les commandes correspondantes. Les filtres magasin / emplacement ne concernent pas les commandes en ligne.",
  ar: "مرشّح « Origine » (WooCommerce أو Shopify أو قناة الطلب اليدوي) ومرشّح « Canal » عند وجود عدة متاجر إلكترونية يحتفظان فقط بالطلبات المطابقة. مرشّحا المتجر والموقع لا يخصّان الطلبات الإلكترونية.",
};
const DELIVERY_FILTER = {
  fr: "« Origine » filtre les commandes ; « Transporteur » garde les commandes dont la dernière expédition réelle est chez ce transporteur.",
  ar: "مرشّح « Origine » يصفّي الطلبات، ومرشّح « Transporteur » يحتفظ بالطلبات التي تعود آخر شحنة فعلية لها إلى شركة التوصيل هذه.",
};
const STORE_FILTER = {
  fr: "« Magasin » et « Emplacement » réduisent aux ventes de ce magasin / de cet emplacement — toujours à l'intérieur de vos propres magasins et emplacements. Les filtres d'origine ne concernent pas les ventes en magasin.",
  ar: "مرشّحا « Magasin » و« Emplacement » يقتصران على مبيعات هذا المتجر أو هذا الموقع، وذلك دائمًا ضمن المتاجر والمواقع المسموح لك بها. مرشّحات المصدر لا تخصّ مبيعات المتجر.",
};
const COMMISSION_FILTER = {
  fr: "« Agent » ne garde que ses écritures ; « Origine » ne garde que les écritures de commandes de cette origine.",
  ar: "مرشّح « Agent » يحتفظ بقيود هذا الوكيل فقط، ومرشّح « Origine » يحتفظ بقيود الطلبات الواردة من هذا المصدر.",
};
const ENTRY_DATE = {
  fr: "Date de l'écriture du registre (createdAt) : le jour où la commande est passée à « Livrée » (gain) ou en est sortie (annulation) — pas la date de la commande.",
  ar: "تاريخ القيد في السجل (createdAt): يوم انتقال الطلب إلى « Livrée » (استحقاق) أو خروجه منها (إلغاء)، وليس تاريخ الطلب.",
};
const SOLD_AT = {
  fr: "Date de la vente en magasin (soldAt), premier et dernier jour inclus, fuseau horaire de la boutique.",
  ar: "تاريخ البيع في المتجر (soldAt)، مع احتساب اليوم الأول والأخير، حسب المنطقة الزمنية للمتجر.",
};
const REVENUE_EXCLUDED = {
  fr: "Commandes de la période, sauf celles au statut Annulée, Échec, Retour ou Remboursée. Les commandes encore « Nouvelle », « Confirmée », « Emballage » ou « Expédiée » comptent déjà.",
  ar: "طلبات الفترة باستثناء الطلبات بحالة Annulée أو Échec أو Retour أو Remboursée. الطلبات التي ما زالت « Nouvelle » أو « Confirmée » أو « Emballage » أو « Expédiée » تُحتسب منذ الآن.",
};
const OUTCOME_RULE = {
  fr: "Résultat FINAL de chaque commande, une seule fois : celui de sa dernière expédition réelle (les tentatives de création API jamais remises au transporteur sont ignorées) ; « Retour » ou « Remboursée » sur la commande l'emporte ; sans expédition, son propre statut (Livrée / Échec).",
  ar: "النتيجة النهائية لكل طلب مرة واحدة فقط: نتيجة آخر شحنة فعلية له (تُهمَل محاولات الإنشاء عبر API التي لم تصل إلى شركة التوصيل)، وتتقدّم حالة « Retour » أو « Remboursée » على الطلب على غيرها، وإن لم تكن له شحنة فحالته هو (Livrée / Échec).",
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const ANALYTICS_METRICS = {
  // ------------------------------------------------------------ Vue d'ensemble
  ordersPlaced: {
    labels: ["Commandes en ligne"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (orders, pending)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le nombre de commandes en ligne reçues sur la période, quel que soit ce qu'elles sont devenues.",
        calculation: "Nombre de commandes dont la date de commande tombe dans la période — tous statuts confondus, annulées comprises. Sous le chiffre : combien sont encore « Nouvelle » (à confirmer).",
        scope: "Commandes en ligne uniquement (WooCommerce, Shopify, commandes manuelles). Jamais les ventes en magasin.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `Boutique Exemple : ${E.orders} commandes passées en septembre (CMD-101 à CMD-110), dont ${E.cancelled} annulée et ${E.pending} encore « Nouvelle » → ${E.orders} commandes, « ${E.pending} encore à confirmer ».`,
        interpretation: "Mesure la demande reçue. Ce n'est ni un nombre de ventes réalisées ni un nombre de livraisons.",
        caveats: "La flèche « vs période précédente » n'apparaît que si chacune des deux périodes compte au moins 20 commandes ; en dessous, la comparaison serait trompeuse.",
      },
      {
        definition: "عدد الطلبات الإلكترونية المستلمة خلال الفترة، بغضّ النظر عمّا آلت إليه.",
        calculation: "عدد الطلبات التي يقع تاريخها داخل الفترة، بجميع الحالات بما فيها الملغاة. تحت الرقم: عدد الطلبات التي ما زالت « Nouvelle » (في انتظار التأكيد).",
        scope: "الطلبات الإلكترونية فقط (WooCommerce وShopify والطلبات اليدوية). لا تشمل أبدًا مبيعات المتجر.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `Boutique Exemple: ${E.orders} طلبات في شهر سبتمبر (من CMD-101 إلى CMD-110)، منها ${E.cancelled} ملغى و${E.pending} ما زالا « Nouvelle » ← ${E.orders} طلبات، و« ${E.pending} encore à confirmer ».`,
        interpretation: "يقيس الطلب الوارد. ليس عدد المبيعات المنجزة ولا عدد عمليات التسليم.",
        caveats: "سهم « vs période précédente » لا يظهر إلا إذا ضمّت كلّ من الفترتين 20 طلبًا على الأقل؛ وما دون ذلك تكون المقارنة مضلِّلة.",
      }
    ),
  },
  confirmedOrders: {
    labels: ["Commandes confirmées", "Confirmées"],
    sections: ["overview", "confirmation"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview / getConfirmationAnalytics (confirmedAt renseigné)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes de la période dont la confirmation tient toujours.",
        calculation: "Nombre de commandes de la période ayant une date de confirmation (confirmedAt). Une commande confirmée puis livrée, en échec ou retournée reste comptée ; une commande rouverte (confirmation effacée) ne l'est plus.",
        scope: "Toutes les commandes passées sur la période. Sur l'onglet Confirmation, l'indication « encore à confirmer » compte celles au statut « Nouvelle ».",
        period: `${PLACED.fr} La date de confirmation elle-même peut être postérieure à la période.`,
        filters: `${ORIGIN_FILTER.fr} Le filtre « Confirmateur » ne change pas ce chiffre (une commande n'appartient à aucun confirmateur avant l'appel).`,
        example: `CMD-101 à CMD-107 ont été confirmées, y compris CMD-105 (échec de livraison) et CMD-106 (retournée) → ${E.confirmed} commandes confirmées.`,
        interpretation: "Combien de commandes reçues ont été validées par le client. Ne dit pas combien ont été livrées.",
      },
      {
        definition: "طلبات الفترة التي ما زال تأكيدها قائمًا.",
        calculation: "عدد طلبات الفترة التي تحمل تاريخ تأكيد (confirmedAt). الطلب المؤكَّد الذي سُلِّم أو فشل تسليمه أو أُرجع يبقى محسوبًا؛ أما الطلب المُعاد فتحه (مُسح تأكيده) فلا يُحتسب.",
        scope: "جميع الطلبات المسجّلة خلال الفترة. في تبويب Confirmation تحسب الإشارة « encore à confirmer » الطلبات بحالة « Nouvelle ».",
        period: `${PLACED.ar} أما تاريخ التأكيد نفسه فقد يكون بعد الفترة.`,
        filters: `${ORIGIN_FILTER.ar} مرشّح « Confirmateur » لا يغيّر هذا الرقم (لا ينتمي الطلب إلى أي مؤكِّد قبل الاتصال).`,
        example: `تم تأكيد الطلبات من CMD-101 إلى CMD-107، بما فيها CMD-105 (فشل التسليم) وCMD-106 (مُرجَع) ← ${E.confirmed} طلبات مؤكَّدة.`,
        interpretation: "كم طلبًا من الطلبات الواردة وافق عليه الزبون. لا يبيّن عدد الطلبات المسلَّمة.",
      }
    ),
  },
  confirmationRate: {
    labels: ["Taux de confirmation"],
    sections: ["overview", "confirmation"],
    source: "src/lib/metrics/formulas.ts — confirmationRatePct",
    access: ONLINE,
    text: bi(
      {
        definition: "La part des commandes appelées qui ont été confirmées.",
        calculation: "Commandes confirmées ÷ commandes passées par la confirmation (au moins une tentative d'appel enregistrée, ou confirmées directement, par exemple à l'import) × 100, arrondi à 0,1. Sous le chiffre : « sur N appelée(s) » = ce dénominateur.",
        scope: "Les commandes jamais appelées restent « À confirmer » et sont hors du calcul.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `${E.wentThroughConfirmation} commandes passées par la confirmation (CMD-101 à CMD-109), ${E.confirmed} confirmées ; CMD-110, jamais appelée, ne compte pas → ${E.confirmed} ÷ ${E.wentThroughConfirmation} = ${pct(E.confirmationRate)}.`,
        interpretation: "Mesure l'efficacité de la confirmation sur les commandes réellement traitées.",
        caveats: "Si aucune commande n'a été appelée, le taux n'est pas calculable (affiché « Aucune commande appelée » / « Aucune commande ») — jamais un faux 0 %. Ce n'est pas « confirmées ÷ toutes les commandes ».",
      },
      {
        definition: "نسبة الطلبات التي تم الاتصال بأصحابها ثم تأكيدها.",
        calculation: "الطلبات المؤكَّدة ÷ الطلبات التي مرّت بمرحلة التأكيد (محاولة اتصال واحدة مسجّلة على الأقل، أو مؤكَّدة مباشرة كما عند الاستيراد) × 100، مقرَّبة إلى 0,1. تحت الرقم: « sur N appelée(s) » هو هذا المقام.",
        scope: "الطلبات التي لم يُتّصل بها بعد تبقى « À confirmer » ولا تدخل في الحساب.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `${E.wentThroughConfirmation} طلبات مرّت بالتأكيد (من CMD-101 إلى CMD-109)، أُكِّد منها ${E.confirmed}؛ والطلب CMD-110 الذي لم يُتّصل به لا يُحتسب ← ${E.confirmed} ÷ ${E.wentThroughConfirmation} = ${pct(E.confirmationRate)}.`,
        interpretation: "يقيس فعالية عملية التأكيد على الطلبات التي عولجت فعلًا.",
        caveats: "إذا لم يُتّصل بأي طلب فالنسبة غير قابلة للحساب (يظهر « Aucune commande appelée » / « Aucune commande »)، وليست 0 % مزيّفة. وهي ليست « المؤكَّدة ÷ كل الطلبات ».",
      }
    ),
  },
  deliveredOrders: {
    labels: ["Commandes livrées"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (outcomes.delivered, shipped)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes de la période arrivées chez le client.",
        calculation: `Nombre de commandes de la période dont le résultat final est « livrée ». ${OUTCOME_RULE.fr} Sous le chiffre : « sur N expédiées » = commandes de la période expédiées (statut Expédiée, Livrée, Échec, Retour, Remboursée, ou date d'expédition renseignée).`,
        period: `${PLACED.fr} Une commande passée fin août et livrée en septembre est comptée en août.`,
        filters: ORIGIN_FILTER.fr,
        example: `CMD-101, 102 et 103 sont livrées ; CMD-104 est encore en route → ${E.delivered} livrées « sur ${E.shipped} expédiées ».`,
        interpretation: "Suit le devenir des commandes reçues sur la période (cohorte).",
        caveats: "L'onglet Livraison compte autrement : les commandes EXPÉDIÉES sur la période (date d'expédition). Les deux « Livrées » peuvent donc différer.",
      },
      {
        definition: "طلبات الفترة التي وصلت إلى الزبون.",
        calculation: `عدد طلبات الفترة التي نتيجتها النهائية « livrée ». ${OUTCOME_RULE.ar} تحت الرقم: « sur N expédiées » هو عدد طلبات الفترة المشحونة (بحالة Expédiée أو Livrée أو Échec أو Retour أو Remboursée، أو التي تحمل تاريخ شحن).`,
        period: `${PLACED.ar} الطلب المسجَّل نهاية غشت والمسلَّم في سبتمبر يُحتسب في غشت.`,
        filters: ORIGIN_FILTER.ar,
        example: `الطلبات CMD-101 و102 و103 مسلَّمة، وCMD-104 ما زال في الطريق ← ${E.delivered} مسلَّمة « sur ${E.shipped} expédiées ».`,
        interpretation: "يتتبّع مآل الطلبات الواردة خلال الفترة (الفوج).",
        caveats: "تبويب Livraison يحسب بطريقة أخرى: الطلبات المشحونة خلال الفترة (تاريخ الشحن). لذلك قد يختلف رقما « Livrées ».",
      }
    ),
  },
  deliveryRate: {
    labels: ["Taux de livraison réussie"],
    sections: ["overview"],
    source: "src/lib/metrics/formulas.ts — deliveryOutcomeRate",
    access: ONLINE,
    text: bi(
      {
        definition: "La part des commandes expédiées arrivées au bout qui ont été livrées.",
        calculation: `Livrées ÷ (livrées + échecs + retournées) × 100, une seule fois par commande. ${OUTCOME_RULE.fr}`,
        scope: "Commandes de la période expédiées ET ayant un résultat. Les colis encore en route et les expéditions annulées n'ont pas de résultat : hors calcul.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `${E.shipped} commandes expédiées : ${E.delivered} livrées, ${E.failed} échec (CMD-105), ${E.returned} retournée (CMD-106), ${E.inProgress} en route (CMD-104) → ${E.delivered} ÷ (${E.delivered} + ${E.failed} + ${E.returned}) = ${pct(E.deliveryRate)}. Une commande échouée puis livrée au 2e envoi compte une fois, comme livrée.`,
        interpretation: "Qualité de la livraison sur les colis dont on connaît l'issue.",
        caveats: "Le taux évolue à mesure que les colis en route arrivent. Sans aucun résultat, il est « Aucune livraison terminée » (pas 0 %).",
      },
      {
        definition: "نسبة الطلبات المشحونة التي اكتمل مسارها وتمّ تسليمها.",
        calculation: `المسلَّمة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100، مرة واحدة لكل طلب. ${OUTCOME_RULE.ar}`,
        scope: "طلبات الفترة المشحونة والتي لها نتيجة. الطرود التي ما زالت في الطريق والشحنات الملغاة ليس لها نتيجة فلا تدخل في الحساب.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `${E.shipped} طلبات مشحونة: ${E.delivered} مسلَّمة، و${E.failed} فاشل (CMD-105)، و${E.returned} مُرجَع (CMD-106)، و${E.inProgress} في الطريق (CMD-104) ← ${E.delivered} ÷ (${E.delivered} + ${E.failed} + ${E.returned}) = ${pct(E.deliveryRate)}. الطلب الذي فشل ثم سُلِّم في الإرسال رقم 2 يُحتسب مرة واحدة كمسلَّم.`,
        interpretation: "جودة التسليم بالنسبة للطرود المعروفة نتيجتها.",
        caveats: "تتغيّر النسبة كلما وصلت الطرود التي في الطريق. وإن لم توجد أي نتيجة يظهر « Aucune livraison terminée » (وليس 0 %).",
      }
    ),
  },
  cancelledOrders: {
    labels: ["Annulées"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (statut ANNULEE)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes de la période actuellement annulées.",
        calculation: "Nombre de commandes de la période dont le statut actuel est « Annulée », qu'elles aient été confirmées ou non.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `CMD-108 a été annulée au téléphone → ${E.cancelled} annulée.`,
        interpretation: "Demande perdue avant l'expédition. Les échecs et retours de livraison sont comptés à part.",
      },
      {
        definition: "طلبات الفترة الملغاة حاليًا.",
        calculation: "عدد طلبات الفترة التي حالتها الحالية « Annulée »، سواء أُكِّدت من قبل أم لا.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `أُلغي الطلب CMD-108 عبر الهاتف ← ${E.cancelled} ملغى.`,
        interpretation: "طلب ضائع قبل الشحن. حالات فشل التسليم والإرجاع تُحتسب على حدة.",
      }
    ),
  },
  failedDeliveries: {
    labels: ["Échecs de livraison"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (outcomes.failed)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes de la période dont la livraison a finalement échoué.",
        calculation: `Nombre de commandes de la période dont le résultat final est « échec ». ${OUTCOME_RULE.fr}`,
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `Le colis de CMD-105 est en échec et n'a pas été renvoyé → ${E.failed} échec. S'il avait été renvoyé et livré, la commande compterait en « livrée », pas en échec.`,
        interpretation: "Colis non remis au client, sans renvoi réussi.",
      },
      {
        definition: "طلبات الفترة التي فشل تسليمها في النهاية.",
        calculation: `عدد طلبات الفترة التي نتيجتها النهائية « échec ». ${OUTCOME_RULE.ar}`,
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `طرد الطلب CMD-105 فشل ولم يُعَد إرساله ← ${E.failed} فاشل. لو أُعيد إرساله وسُلِّم لاحتُسب الطلب « livrée » وليس فاشلًا.`,
        interpretation: "طرود لم تُسلَّم للزبون دون إعادة إرسال ناجحة.",
      }
    ),
  },
  returnedOrders: {
    labels: ["Retournées"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (outcomes.returned)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes de la période revenues : colis retourné, ou commande passée en « Retour » / « Remboursée ».",
        calculation: `Nombre de commandes de la période dont le résultat final est « retournée ». ${OUTCOME_RULE.fr}`,
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `CMD-106 est revenue (colis « Retourné », commande « Retour ») → ${E.returned} retournée.`,
        interpretation: "Marchandise revenue. Un retour ne signifie pas automatiquement un remboursement : les remboursements sont dans « Remboursé ».",
      },
      {
        definition: "طلبات الفترة التي عادت: طرد مُرجَع، أو طلب انتقل إلى « Retour » / « Remboursée ».",
        calculation: `عدد طلبات الفترة التي نتيجتها النهائية « retournée ». ${OUTCOME_RULE.ar}`,
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `عاد الطلب CMD-106 (طرد « Retourné » وطلب « Retour ») ← ${E.returned} مُرجَع.`,
        interpretation: "بضاعة عادت. الإرجاع لا يعني تلقائيًا استرداد المبلغ: الاستردادات تظهر في « Remboursé ».",
      }
    ),
  },
  netRevenue: {
    labels: ["Chiffre d'affaires"],
    sections: ["overview"],
    source: "src/lib/metrics/formulas.ts — netRevenue ; online.ts — getOnlineOverview (placedRevenue, netRevenue)",
    access: ONLINE,
    text: bi(
      {
        definition: "Ce que la boutique a vendu en ligne sur la période, remboursements déduits.",
        calculation: "Somme des totaux des commandes valides (frais de livraison facturés au client compris, remises déduites) − remboursements au statut « Complété » enregistrés sur CES commandes. Sous le chiffre : « Brut » = la somme avant déduction.",
        scope: REVENUE_EXCLUDED.fr,
        period: `${PLACED.fr} Un remboursement compte dans la période de la commande remboursée, même s'il a été fait plus tard.`,
        filters: ORIGIN_FILTER.fr,
        example: `Commandes valides : CMD-101, 102, 103, 104, 107, 109, 110 = ${mad(E.grossRevenue)} brut. Remboursement de ${mad(E.revenueRefunds)} sur CMD-103 → ${mad(E.grossRevenue)} − ${mad(E.revenueRefunds)} = ${mad(E.netRevenue)}. CMD-105 (échec), CMD-106 (retour) et CMD-108 (annulée) ne comptent pas.`,
        interpretation: "Le chiffre d'affaires commandé et non annulé. Ce n'est pas l'argent encaissé : une commande « Nouvelle » ou « Expédiée » est déjà comptée.",
        caveats: `Les remboursements des commandes déjà exclues (Retour, Remboursée) ne sont pas déduits une 2e fois : « Brut − Remboursé » n'est donc pas forcément égal au chiffre d'affaires (exemple : ${mad(E.grossRevenue)} − ${mad(E.refunded)} ≠ ${mad(E.netRevenue)}).`,
      },
      {
        definition: "ما باعه المتجر إلكترونيًا خلال الفترة بعد خصم الاستردادات.",
        calculation: "مجموع مبالغ الطلبات الصالحة (بما فيها رسوم التوصيل المفوترة للزبون، وبعد خصم التخفيضات) − الاستردادات بحالة « Complété » المسجّلة على هذه الطلبات نفسها. تحت الرقم: « Brut » هو المجموع قبل الخصم.",
        scope: REVENUE_EXCLUDED.ar,
        period: `${PLACED.ar} يُحتسب الاسترداد في فترة الطلب المسترَدّ حتى لو تمّ لاحقًا.`,
        filters: ORIGIN_FILTER.ar,
        example: `الطلبات الصالحة: CMD-101 و102 و103 و104 و107 و109 و110 = ${mad(E.grossRevenue)} إجمالي. استرداد ${mad(E.revenueRefunds)} على CMD-103 ← ${mad(E.grossRevenue)} − ${mad(E.revenueRefunds)} = ${mad(E.netRevenue)}. الطلبات CMD-105 (فشل) وCMD-106 (إرجاع) وCMD-108 (ملغى) لا تُحتسب.`,
        interpretation: "رقم المعاملات المطلوب وغير الملغى. ليس المبلغ المحصَّل: الطلب بحالة « Nouvelle » أو « Expédiée » يُحتسب منذ الآن.",
        caveats: `استردادات الطلبات المستبعدة أصلًا (Retour وRemboursée) لا تُخصم مرة ثانية؛ لذلك « Brut − Remboursé » لا يساوي بالضرورة رقم المعاملات (في المثال: ${mad(E.grossRevenue)} − ${mad(E.refunded)} ≠ ${mad(E.netRevenue)}).`,
      }
    ),
  },
  deliveredRevenue: {
    labels: ["CA livré"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (deliveredRevenue)",
    access: ONLINE,
    text: bi(
      {
        definition: "La valeur des commandes de la période qui sont aujourd'hui au statut « Livrée ».",
        calculation: "Somme des totaux (livraison facturée comprise) des commandes de la période au statut actuel « Livrée ». Les remboursements ne sont PAS déduits.",
        period: `${PLACED.fr} Ce n'est pas « livré pendant la période » : c'est « commandé pendant la période et livré depuis ».`,
        filters: ORIGIN_FILTER.fr,
        example: `CMD-101 (300) + CMD-102 (250) + CMD-103 (360) → ${mad(E.deliveredRevenue)}, bien que ${mad(E.revenueRefunds)} aient été remboursés sur CMD-103.`,
        interpretation: "La part du chiffre d'affaires déjà concrétisée par une livraison.",
        caveats: "Repose sur le statut de la commande ; le nombre « Commandes livrées » repose sur le résultat de la dernière expédition. Les deux concordent normalement (l'expédition met la commande à jour).",
      },
      {
        definition: "قيمة طلبات الفترة التي حالتها اليوم « Livrée ».",
        calculation: "مجموع مبالغ طلبات الفترة (بما فيها رسوم التوصيل المفوترة) ذات الحالة الحالية « Livrée ». لا تُخصم الاستردادات.",
        period: `${PLACED.ar} ليس « ما سُلِّم خلال الفترة »، بل « ما طُلب خلال الفترة وسُلِّم منذ ذلك ».`,
        filters: ORIGIN_FILTER.ar,
        example: `CMD-101 (300) + CMD-102 (250) + CMD-103 (360) ← ${mad(E.deliveredRevenue)}، رغم استرداد ${mad(E.revenueRefunds)} على CMD-103.`,
        interpretation: "الجزء من رقم المعاملات الذي تحقّق فعلًا بالتسليم.",
        caveats: "يعتمد على حالة الطلب، بينما يعتمد رقم « Commandes livrées » على نتيجة آخر شحنة. يتطابقان عادةً (لأن الشحنة تحدّث حالة الطلب).",
      }
    ),
  },
  averageBasket: {
    labels: ["Panier moyen"],
    sections: ["overview"],
    source: "src/lib/metrics/formulas.ts — averageBasket",
    access: ONLINE,
    text: bi(
      {
        definition: "La valeur moyenne d'une commande valide.",
        calculation: "Total BRUT des commandes valides ÷ nombre de commandes valides, arrondi à 0,01. Les remboursements, plus tardifs, ne réduisent pas le panier.",
        scope: REVENUE_EXCLUDED.fr,
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `${mad(E.grossRevenue)} ÷ ${E.revenueOrders} commandes valides = ${mad(E.averageBasket ?? 0)}. Le dénominateur n'est ni les ${E.orders} commandes reçues ni les ${E.delivered} livrées.`,
        interpretation: "Combien rapporte en moyenne une commande qui n'est ni annulée, ni en échec, ni retournée.",
        caveats: "Frais de livraison facturés compris. Aucune commande valide : « Aucune commande » (pas 0).",
      },
      {
        definition: "متوسط قيمة الطلب الصالح.",
        calculation: "المجموع الإجمالي للطلبات الصالحة ÷ عدد الطلبات الصالحة، مقرَّبًا إلى 0,01. الاستردادات اللاحقة لا تُنقص السلة.",
        scope: REVENUE_EXCLUDED.ar,
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `${mad(E.grossRevenue)} ÷ ${E.revenueOrders} طلبات صالحة = ${mad(E.averageBasket ?? 0)}. المقام ليس الطلبات الواردة (${E.orders}) ولا المسلَّمة (${E.delivered}).`,
        interpretation: "متوسط ما يدرّه الطلب غير الملغى وغير الفاشل وغير المُرجَع.",
        caveats: "يشمل رسوم التوصيل المفوترة. إن لم يوجد أي طلب صالح يظهر « Aucune commande » (وليس 0).",
      }
    ),
  },
  unitsSold: {
    labels: ["Unités vendues"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (units)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le nombre d'articles commandés dans les commandes valides de la période.",
        calculation: "Somme des quantités des lignes des commandes valides.",
        scope: REVENUE_EXCLUDED.fr,
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `CMD-101 (2) + 102 (2) + 103 (3) + 104 (2) + 107 (1) + 109 (1) + 110 (1) = ${E.unitsSold} unités.`,
        interpretation: "Volume commandé, pas volume livré : les commandes pas encore confirmées ou expédiées comptent.",
      },
      {
        definition: "عدد القطع المطلوبة في الطلبات الصالحة خلال الفترة.",
        calculation: "مجموع كميات أسطر الطلبات الصالحة.",
        scope: REVENUE_EXCLUDED.ar,
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `CMD-101 (2) + 102 (2) + 103 (3) + 104 (2) + 107 (1) + 109 (1) + 110 (1) = ${E.unitsSold} قطعة.`,
        interpretation: "حجم مطلوب وليس حجمًا مسلَّمًا: الطلبات غير المؤكَّدة أو غير المشحونة بعد تُحتسب.",
      }
    ),
  },
  refunded: {
    labels: ["Remboursé"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineOverview (refundedAmount, returnedValue)",
    access: ONLINE,
    text: bi(
      {
        definition: "L'argent rendu aux clients pour les commandes de la période.",
        calculation: "Somme des remboursements au statut « Complété » de TOUTES les commandes de la période (partiels et totaux), quel que soit leur statut. Sous le chiffre : « Valeur retournée » = total des commandes au statut Retour ou Remboursée.",
        period: `${PLACED.fr} C'est la date de la commande qui compte, pas celle du remboursement.`,
        filters: ORIGIN_FILTER.fr,
        example: `${mad(85)} (geste sur CMD-103, livrée) + ${mad(330)} (articles de CMD-106, retournée) = ${mad(E.refunded)}. Valeur retournée : CMD-106 = ${mad(E.returnedValue)}.`,
        interpretation: "Montant effectivement remboursé. Un retour sans remboursement enregistré n'y figure pas ; un remboursement en attente non plus.",
        caveats: `Seul le remboursement de CMD-103 (${mad(E.revenueRefunds)}) est déduit du chiffre d'affaires : CMD-106 en est déjà exclue.`,
      },
      {
        definition: "المبالغ المُعادة للزبائن عن طلبات الفترة.",
        calculation: "مجموع الاستردادات بحالة « Complété » لجميع طلبات الفترة (جزئية وكاملة) مهما كانت حالتها. تحت الرقم: « Valeur retournée » هو مجموع الطلبات بحالة Retour أو Remboursée.",
        period: `${PLACED.ar} العبرة بتاريخ الطلب لا بتاريخ الاسترداد.`,
        filters: ORIGIN_FILTER.ar,
        example: `${mad(85)} (تعويض على CMD-103 المسلَّم) + ${mad(330)} (قطع CMD-106 المُرجَع) = ${mad(E.refunded)}. القيمة المُرجَعة: CMD-106 = ${mad(E.returnedValue)}.`,
        interpretation: "المبلغ المسترَدّ فعلًا. الإرجاع دون استرداد مسجَّل لا يظهر هنا، ولا الاسترداد المعلَّق.",
        caveats: `وحده استرداد CMD-103 (${mad(E.revenueRefunds)}) يُخصم من رقم المعاملات، لأن CMD-106 مستبعد منه أصلًا.`,
      }
    ),
  },
  periodComparison: {
    labels: ["vs période précédente"],
    sections: ["overview"],
    source: "src/lib/analytics/period.ts — meaningfulDelta, previousPeriodOfSameLength",
    access: ONLINE,
    text: bi(
      {
        definition: "L'évolution affichée sur « Commandes en ligne » et « Chiffre d'affaires ».",
        calculation: "(valeur de la période − valeur de la période précédente) ÷ |valeur précédente| × 100, à 0,1 près. La période précédente a exactement la même durée et se termine juste avant le début de la période choisie.",
        example: "Période du 1er au 30 septembre comparée au 2–31 août (même durée : 30 jours). 48 commandes contre 40 → +20 %.",
        interpretation: "Une tendance, pas un objectif.",
        caveats: "Masquée si l'une des deux périodes compte moins de 20 commandes (même pour le chiffre d'affaires), ou si la valeur précédente est 0.",
      },
      {
        definition: "التطوّر المعروض على « Commandes en ligne » و« Chiffre d'affaires ».",
        calculation: "(قيمة الفترة − قيمة الفترة السابقة) ÷ |القيمة السابقة| × 100، مقرَّبًا إلى 0,1. الفترة السابقة لها المدة نفسها تمامًا وتنتهي مباشرة قبل بداية الفترة المختارة.",
        example: "الفترة من 1 إلى 30 سبتمبر مقارنة بالفترة من 2 إلى 31 غشت (المدة نفسها: 30 يومًا). 48 طلبًا مقابل 40 ← ‎+20 %.",
        interpretation: "اتجاه عام، وليس هدفًا.",
        caveats: "يُخفى إذا ضمّت إحدى الفترتين أقل من 20 طلبًا (حتى بالنسبة لرقم المعاملات)، أو إذا كانت القيمة السابقة 0.",
      }
    ),
  },
  revenueOrdersChart: {
    labels: ["Chiffre d'affaires et commandes"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/online.ts — getOnlineRevenueSeries",
    access: ONLINE,
    text: bi(
      {
        definition: "Le chiffre d'affaires (barres) et le nombre de commandes (ligne), jour par jour — mois par mois au-delà de 62 jours.",
        calculation: "Chaque commande est placée au jour de sa date de commande. Barres : chiffre d'affaires net, même règle que la carte (un remboursement est déduit au jour de la commande). Ligne : toutes les commandes, annulées comprises.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: "Le 12 septembre : 3 commandes dont 1 annulée de 140 MAD → ligne à 3, barre = total des 2 autres.",
        interpretation: "La somme des barres égale la carte « Chiffre d'affaires » ; la somme de la ligne égale « Commandes en ligne ».",
      },
      {
        definition: "رقم المعاملات (أعمدة) وعدد الطلبات (خط)، يومًا بيوم، وشهرًا بشهر إذا تجاوزت الفترة 62 يومًا.",
        calculation: "يُوضع كل طلب في يوم تاريخ الطلب. الأعمدة: رقم المعاملات الصافي بنفس قاعدة البطاقة (يُخصم الاسترداد في يوم الطلب). الخط: جميع الطلبات بما فيها الملغاة.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: "في 12 سبتمبر: 3 طلبات منها 1 ملغى بقيمة 140 MAD ← الخط عند 3، والعمود = مجموع الطلبات الـ2 الأخرى.",
        interpretation: "مجموع الأعمدة يساوي بطاقة « Chiffre d'affaires »، ومجموع الخط يساوي « Commandes en ligne ».",
      }
    ),
  },
  orderFunnel: {
    labels: ["Entonnoir des commandes"],
    sections: ["overview"],
    source: "src/app/(protected)/analyses/page.tsx — FunnelBars ; online.ts — getOnlineOverview",
    access: ONLINE,
    text: bi(
      {
        definition: "Le parcours des commandes de la période : passées → confirmées → expédiées → livrées.",
        calculation: "Quatre comptages sur la MÊME population (commandes passées sur la période) : Passées = toutes ; Confirmées = confirmation qui tient ; Expédiées = statut Expédiée/Livrée/Échec/Retour/Remboursée ou date d'expédition ; Livrées = résultat final livré. Chaque pourcentage = étape ÷ « Passées ».",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `${E.orders} → ${E.confirmed} (${pct((E.confirmed / E.orders) * 100)}) → ${E.shipped} (${pct((E.shipped / E.orders) * 100)}) → ${E.delivered} (${pct((E.delivered / E.orders) * 100)}).`,
        interpretation: "Les pourcentages sont des parts du total reçu, pas des taux d'une étape à l'autre : le taux de confirmation et le taux de livraison réussie ont leurs propres cartes.",
        caveats: "La mention « Statut actuel » sous « Livrées » désigne en réalité le résultat final de livraison (dernière expédition). Les commandes récentes n'ont pas encore parcouru tout l'entonnoir.",
      },
      {
        definition: "مسار طلبات الفترة: مسجَّلة ← مؤكَّدة ← مشحونة ← مسلَّمة.",
        calculation: "أربع عمليات عدّ على المجموعة نفسها (الطلبات المسجَّلة خلال الفترة): Passées = كلها؛ Confirmées = تأكيدها قائم؛ Expédiées = حالة Expédiée/Livrée/Échec/Retour/Remboursée أو وجود تاريخ شحن؛ Livrées = النتيجة النهائية مسلَّمة. كل نسبة = المرحلة ÷ « Passées ».",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `${E.orders} مسجَّلة ← ${E.confirmed} مؤكَّدة (${pct((E.confirmed / E.orders) * 100)}) ← ${E.shipped} مشحونة (${pct((E.shipped / E.orders) * 100)}) ← ${E.delivered} مسلَّمة (${pct((E.delivered / E.orders) * 100)}).`,
        interpretation: "النسب حصص من مجموع الطلبات الواردة، وليست نسب انتقال من مرحلة إلى أخرى: لنسبة التأكيد ونسبة التسليم الناجح بطاقاتهما الخاصة.",
        caveats: "عبارة « Statut actuel » تحت « Livrées » تعني في الواقع النتيجة النهائية للتسليم (آخر شحنة). الطلبات الحديثة لم تقطع بعد كامل المسار.",
      }
    ),
  },
  topProducts: {
    labels: ["Produits les plus vendus en ligne"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/products.ts — getOnlineProductPerformance",
    access: ONLINE,
    text: bi(
      {
        definition: "Les 5 produits / variations les plus vendus en ligne, par unités.",
        calculation: "Mêmes colonnes et mêmes règles que l'onglet Produits (unités, commandes distinctes, CA des lignes, unités retournées reçues), triées par unités décroissantes.",
        scope: REVENUE_EXCLUDED.fr,
        period: `${PLACED.fr} Unités retournées : date de réception du retour.`,
        filters: ORIGIN_FILTER.fr,
        example: `Sac Atlas en tête : ${sac.units} unités dans ${sac.orders} commandes, ${mad(sac.revenue)}.`,
        interpretation: "Un aperçu ; le tableau complet est dans l'onglet Produits.",
      },
      {
        definition: "أكثر 5 منتجات / متغيّرات مبيعًا إلكترونيًا حسب عدد القطع.",
        calculation: "الأعمدة والقواعد نفسها المعتمدة في تبويب Produits (القطع، الطلبات المتميّزة، رقم معاملات الأسطر، القطع المُرجَعة المستلَمة)، مرتّبة تنازليًا حسب القطع.",
        scope: REVENUE_EXCLUDED.ar,
        period: `${PLACED.ar} القطع المُرجَعة: تاريخ استلام الإرجاع.`,
        filters: ORIGIN_FILTER.ar,
        example: `Sac Atlas في المقدّمة: ${sac.units} قطع في ${sac.orders} طلبات، ${mad(sac.revenue)}.`,
        interpretation: "نظرة سريعة؛ الجدول الكامل في تبويب Produits.",
      }
    ),
  },
  commissionsEarned: {
    labels: ["Commissions gagnées"],
    sections: ["overview", "commissions"],
    source: "src/lib/analytics/queries/commissions.ts — getCommissionAnalytics ; src/lib/commissions.ts — reconcileOrderCommission",
    access: COMMISSIONS,
    text: bi(
      {
        definition: "Les commissions acquises par les agents de confirmation sur la période.",
        calculation: "Somme des écritures « gagnée » du registre. Une écriture est créée quand une commande attribuée à un agent passe à « Livrée » ; son montant est le tarif FIXE par commande de l'agent à ce moment-là (pas un pourcentage des ventes).",
        period: ENTRY_DATE.fr,
        filters: COMMISSION_FILTER.fr,
        example: `${EXAMPLE_COMMISSION.agent}, ${EXAMPLE_COMMISSION.ratePerOrder} MAD par commande livrée : ${EXAMPLE_COMMISSION.earnedEntries} commandes livrées en septembre → ${mad(commissionEarned)} (${EXAMPLE_COMMISSION.earnedEntries} écritures).`,
        interpretation: "Ce que les agents ont gagné sur la période, avant annulations et indépendamment des paiements.",
        caveats: "Le registre n'est jamais recalculé : un changement de tarif ne touche pas les écritures passées.",
      },
      {
        definition: "العمولات التي استحقّها وكلاء التأكيد خلال الفترة.",
        calculation: "مجموع قيود « gagnée » في السجل. يُنشأ القيد عندما ينتقل طلب منسوب إلى وكيل إلى « Livrée »، ومبلغه هو التعريفة الثابتة لكل طلب لدى الوكيل في تلك اللحظة (وليس نسبة من المبيعات).",
        period: ENTRY_DATE.ar,
        filters: COMMISSION_FILTER.ar,
        example: `${EXAMPLE_COMMISSION.agent}، ${EXAMPLE_COMMISSION.ratePerOrder} MAD لكل طلب مسلَّم: ${EXAMPLE_COMMISSION.earnedEntries} طلبات سُلِّمت في سبتمبر ← ${mad(commissionEarned)} (${EXAMPLE_COMMISSION.earnedEntries} قيود).`,
        interpretation: "ما استحقّه الوكلاء خلال الفترة، قبل الإلغاءات وبصرف النظر عن الأداء.",
        caveats: "لا يُعاد حساب السجل أبدًا: تغيير التعريفة لا يمسّ القيود السابقة.",
      }
    ),
  },
  commissionsReversed: {
    labels: ["Commissions annulées"],
    sections: ["overview", "commissions"],
    source: "src/lib/analytics/queries/commissions.ts — getCommissionAnalytics",
    access: COMMISSIONS,
    text: bi(
      {
        definition: "Les commissions reprises parce que la commande n'est plus livrée.",
        calculation: "Somme (en positif) des écritures « annulée » : créées quand une commande déjà commissionnée quitte « Livrée » (retour, remboursement…), du montant gagné.",
        period: ENTRY_DATE.fr,
        filters: COMMISSION_FILTER.fr,
        example: `Une commande livrée en août revient en septembre → écriture d'annulation de ${mad(commissionReversed)} datée de septembre.`,
        interpretation: "Une annulation peut concerner un gain d'une période antérieure.",
        caveats: "Une commande annulée une fois ne génère plus jamais de commission, même si elle redevient « Livrée ».",
      },
      {
        definition: "العمولات المسترجَعة لأن الطلب لم يعد مسلَّمًا.",
        calculation: "مجموع (بالموجب) قيود « annulée »: تُنشأ عندما يغادر طلبٌ سبق احتساب عمولته حالة « Livrée » (إرجاع، استرداد…) وبمبلغ العمولة المستحقة.",
        period: ENTRY_DATE.ar,
        filters: COMMISSION_FILTER.ar,
        example: `طلب سُلِّم في غشت ثم عاد في سبتمبر ← قيد إلغاء بقيمة ${mad(commissionReversed)} بتاريخ سبتمبر.`,
        interpretation: "قد يخصّ الإلغاء عمولة مستحقة في فترة سابقة.",
        caveats: "الطلب الذي أُلغيت عمولته مرة لا يولّد عمولة أبدًا بعد ذلك، حتى لو عاد إلى « Livrée ».",
      }
    ),
  },
  commissionsNet: {
    labels: ["Commissions nettes"],
    sections: ["overview", "commissions"],
    source: "src/lib/analytics/queries/commissions.ts — getCommissionAnalytics",
    access: COMMISSIONS,
    text: bi(
      {
        definition: "Le solde des commissions de la période.",
        calculation: "Commissions gagnées − commissions annulées, toutes écritures de la période.",
        period: ENTRY_DATE.fr,
        filters: COMMISSION_FILTER.fr,
        example: `${mad(commissionEarned)} − ${mad(commissionReversed)} = ${mad(commissionEarned - commissionReversed)}.`,
        interpretation: "Charge de commission nette de la période. Ce n'est pas le « reste à payer » (les paiements sont gérés dans /commissions).",
        caveats: "Les agents payés dans des devises différentes sont additionnés tels quels.",
      },
      {
        definition: "رصيد العمولات خلال الفترة.",
        calculation: "العمولات المستحقة − العمولات الملغاة، لكل قيود الفترة.",
        period: ENTRY_DATE.ar,
        filters: COMMISSION_FILTER.ar,
        example: `المستحقة ${mad(commissionEarned)} − الملغاة ${mad(commissionReversed)} = الصافي ${mad(commissionEarned - commissionReversed)}.`,
        interpretation: "صافي كلفة العمولات خلال الفترة. ليس « المتبقّي للأداء » (تُدار الأداءات في /commissions).",
        caveats: "الوكلاء الذين يُدفع لهم بعملات مختلفة تُجمع مبالغهم كما هي.",
      }
    ),
  },
  cogs: {
    labels: ["Coût des marchandises"],
    sections: ["overview"],
    source: "src/lib/profitability.ts — computePeriodProfitability (cogs)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce qu'ont coûté les articles des commandes valides de la période.",
        calculation: "Σ (coût d'achat figé sur la ligne au moment de la vente × quantité) pour toutes les lignes des commandes valides.",
        scope: REVENUE_EXCLUDED.fr,
        period: PLACED.fr,
        filters: "Calculé seulement sans filtre, ou avec Origine = WooCommerce / Shopify (la définition de Finance ne connaît que ces filtres).",
        example: `Sac Atlas ${sac.units} × 60 + Foulard Rif 3 × 40 + Ceinture Fès 4 × 50 = ${mad(E.finance.cogs)}.`,
        caveats: "Si une seule ligne n'a pas de coût figé, le total n'est pas calculé (« Coût manquant ») plutôt que sous-estimé.",
      },
      {
        definition: "كلفة القطع في الطلبات الصالحة خلال الفترة.",
        calculation: "Σ (كلفة الشراء المثبّتة على السطر لحظة البيع × الكمية) لكل أسطر الطلبات الصالحة.",
        scope: REVENUE_EXCLUDED.ar,
        period: PLACED.ar,
        filters: "يُحسب فقط دون مرشّح، أو مع Origine = WooCommerce / Shopify (تعريف قسم المالية لا يعرف غير هذين المرشّحين).",
        example: `الكلفة: Sac Atlas ${sac.units} × 60 + Foulard Rif 3 × 40 + Ceinture Fès 4 × 50 = ${mad(E.finance.cogs)}.`,
        caveats: "إذا كان سطر واحد بلا كلفة مثبّتة فلا يُحسب المجموع (« Coût manquant ») بدل تقديم رقم ناقص.",
      }
    ),
  },
  grossProfit: {
    labels: ["Bénéfice brut"],
    sections: ["overview"],
    source: "src/lib/profitability.ts — computePeriodProfitability (grossProfit, grossMarginPct)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce qu'il reste du chiffre d'affaires après le coût des marchandises.",
        calculation: "Chiffre d'affaires net (remboursements déduits) − coût des marchandises. Marge = bénéfice brut ÷ chiffre d'affaires net × 100.",
        scope: REVENUE_EXCLUDED.fr,
        period: PLACED.fr,
        filters: "Comme « Coût des marchandises ».",
        example: `${mad(E.finance.revenue)} − ${mad(E.finance.cogs)} = ${mad(E.finance.grossProfit)} ; marge ${pct(E.finance.grossMarginPct)}.`,
        caveats: "Le « Bénéfice brut » du tableau Produits se calcule autrement (CA des lignes − coût, sans remboursements ni frais de livraison).",
      },
      {
        definition: "ما يتبقّى من رقم المعاملات بعد كلفة البضاعة.",
        calculation: "رقم المعاملات الصافي (بعد الاستردادات) − كلفة البضاعة. الهامش = الربح الإجمالي ÷ رقم المعاملات الصافي × 100.",
        scope: REVENUE_EXCLUDED.ar,
        period: PLACED.ar,
        filters: "مثل « Coût des marchandises ».",
        example: `${mad(E.finance.revenue)} − ${mad(E.finance.cogs)} = ${mad(E.finance.grossProfit)}؛ الهامش ${pct(E.finance.grossMarginPct)}.`,
        caveats: "« Bénéfice brut » في جدول Produits يُحسب بطريقة أخرى (رقم معاملات الأسطر − الكلفة، دون استردادات ولا رسوم توصيل).",
      }
    ),
  },
  netProfit: {
    labels: ["Bénéfice net"],
    sections: ["overview"],
    source: "src/lib/profitability.ts — computePeriodProfitability (netProfit, netMarginPct)",
    access: FINANCE,
    text: bi(
      {
        definition: "Le résultat après marchandises, dépenses et livraison.",
        calculation: "Bénéfice brut − dépenses enregistrées de la période − coût de livraison. Marge nette = bénéfice net ÷ chiffre d'affaires net × 100.",
        period: `${PLACED.fr} Dépenses : leur propre date.`,
        filters: "Comme « Coût des marchandises ». Les dépenses ne sont jamais filtrées par origine.",
        example: `${mad(E.finance.grossProfit)} − ${mad(E.finance.expenses)} − ${mad(E.finance.deliveryCost)} = ${mad(E.finance.netProfit)} ; marge ${pct(E.finance.netMarginPct)}.`,
        caveats: "Non calculable si le coût des marchandises ne l'est pas. Les commissions ne sont pas déduites ici.",
      },
      {
        definition: "النتيجة بعد البضاعة والمصاريف والتوصيل.",
        calculation: "الربح الإجمالي − المصاريف المسجّلة خلال الفترة − كلفة التوصيل. الهامش الصافي = الربح الصافي ÷ رقم المعاملات الصافي × 100.",
        period: `${PLACED.ar} المصاريف: بتاريخها الخاص.`,
        filters: "مثل « Coût des marchandises ». المصاريف لا تُصفّى أبدًا حسب المصدر.",
        example: `${mad(E.finance.grossProfit)} − ${mad(E.finance.expenses)} − ${mad(E.finance.deliveryCost)} = ${mad(E.finance.netProfit)}؛ الهامش ${pct(E.finance.netMarginPct)}.`,
        caveats: "غير قابل للحساب إذا تعذّر حساب كلفة البضاعة. العمولات لا تُخصم هنا.",
      }
    ),
  },
  expenses: {
    labels: ["Dépenses enregistrées"],
    sections: ["overview"],
    source: "src/lib/profitability.ts — computePeriodProfitability (expensesTotal)",
    access: FINANCE,
    text: bi(
      {
        definition: "Les dépenses saisies dans /depenses pour la période.",
        calculation: "Somme des montants des dépenses dont la date est dans la période (publicité et autres catégories).",
        period: "Date de la dépense, premier et dernier jour inclus.",
        filters: "Aucun filtre d'origine ne s'applique aux dépenses.",
        example: `200 MAD de publicité saisis le 15 septembre → ${mad(E.finance.expenses)}, déjà déduits du bénéfice net.`,
      },
      {
        definition: "المصاريف المُدخلة في /depenses خلال الفترة.",
        calculation: "مجموع مبالغ المصاريف التي يقع تاريخها داخل الفترة (إشهار وفئات أخرى).",
        period: "تاريخ المصروف، مع احتساب اليوم الأول والأخير.",
        filters: "لا ينطبق أي مرشّح للمصدر على المصاريف.",
        example: `200 MAD إشهار مسجّلة في 15 سبتمبر ← ${mad(E.finance.expenses)}، مخصومة أصلًا من الربح الصافي.`,
      }
    ),
  },
  deliveryCost: {
    labels: ["Coût de livraison"],
    sections: ["overview"],
    source: "src/lib/profitability.ts — computePeriodProfitability (deliveryCostTotal)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce que la livraison a coûté à la boutique pour les commandes de la période.",
        calculation: "Somme des coûts enregistrés sur les expéditions des commandes de la période — livraison, frais de retour, frais d'échec, corrections manuelles — toutes tentatives comprises.",
        scope: "Hors expéditions annulées et hors commandes annulées.",
        period: PLACED.fr,
        example: `4 colis à 35 MAD (CMD-101 à 104) + 20 MAD d'échec (CMD-105) + 20 MAD de retour (CMD-106) = ${mad(E.finance.deliveryCost)}.`,
        caveats: "C'est le coût payé au transporteur, différent des frais de livraison facturés au client (qui sont dans le chiffre d'affaires).",
      },
      {
        definition: "ما كلّفه التوصيل للمتجر عن طلبات الفترة.",
        calculation: "مجموع الكلف المسجّلة على شحنات طلبات الفترة — التوصيل ورسوم الإرجاع ورسوم الفشل والتصحيحات اليدوية — مع احتساب كل المحاولات.",
        scope: "باستثناء الشحنات الملغاة والطلبات الملغاة.",
        period: PLACED.ar,
        example: `4 طرود بـ35 MAD (من CMD-101 إلى 104) + 20 MAD فشل (CMD-105) + 20 MAD إرجاع (CMD-106) = ${mad(E.finance.deliveryCost)}.`,
        caveats: "هذه الكلفة المؤدّاة لشركة التوصيل، وهي غير رسوم التوصيل المفوترة للزبون (المدرجة في رقم المعاملات).",
      }
    ),
  },
  storeSales: {
    labels: ["Ventes"],
    sections: ["overview"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (offline.salesCount, unitsSold)",
    access: STORE,
    text: bi(
      {
        definition: "Le nombre de ventes en magasin (caisse) de la période.",
        calculation: "Nombre de ventes en magasin. Sous le chiffre : somme des quantités vendues.",
        scope: "Vos magasins et emplacements uniquement. Jamais les commandes en ligne.",
        period: SOLD_AT.fr,
        filters: STORE_FILTER.fr,
        example: `${EXAMPLE_STORE.sales.length} tickets (${EXAMPLE_STORE.sales.join(", ")} MAD) → ${EXAMPLE_STORE.sales.length} ventes, ${EXAMPLE_STORE.units} unités.`,
      },
      {
        definition: "عدد المبيعات في المتجر (الصندوق) خلال الفترة.",
        calculation: "عدد عمليات البيع في المتجر. تحت الرقم: مجموع الكميات المبيعة.",
        scope: "متاجرك ومواقعك فقط. لا تشمل أبدًا الطلبات الإلكترونية.",
        period: SOLD_AT.ar,
        filters: STORE_FILTER.ar,
        example: `${EXAMPLE_STORE.sales.length} تذاكر (${EXAMPLE_STORE.sales.join("، ")} MAD) ← ${EXAMPLE_STORE.sales.length} مبيعات، ${EXAMPLE_STORE.units} قطع.`,
      }
    ),
  },
  storeGrossSales: {
    labels: ["CA brut magasin"],
    sections: ["overview"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (grossSales) ; store.ts — getStoreOverview (series)",
    access: STORE,
    text: bi(
      {
        definition: "Le total encaissé en magasin, avant remboursements. Le graphique montre le même montant jour par jour.",
        calculation: "Somme des totaux des ventes en magasin de la période.",
        period: SOLD_AT.fr,
        filters: STORE_FILTER.fr,
        example: `${EXAMPLE_STORE.sales.join(" + ")} = ${mad(storeGross)}.`,
      },
      {
        definition: "المجموع المحصَّل في المتجر قبل الاستردادات. يعرض المبيان المبلغ نفسه يومًا بيوم.",
        calculation: "مجموع مبالغ مبيعات المتجر خلال الفترة.",
        period: SOLD_AT.ar,
        filters: STORE_FILTER.ar,
        example: `مجموع التذاكر: ${EXAMPLE_STORE.sales.join(" + ")} = ${mad(storeGross)}.`,
      }
    ),
  },
  storeRefunds: {
    labels: ["Remboursements"],
    sections: ["overview"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (refunds)",
    access: STORE,
    text: bi(
      {
        definition: "L'argent rendu sur les retours en magasin reçus pendant la période.",
        calculation: "Somme des remboursements des retours en magasin dont la date de réception est dans la période.",
        period: "Date de réception du retour (receivedAt) — PAS la date de la vente.",
        filters: STORE_FILTER.fr,
        example: `Un client rapporte le 20 septembre un article acheté le 28 août : ${mad(EXAMPLE_STORE.refundsReceived)} remboursés comptent en septembre.`,
        caveats: "Contrairement aux commandes en ligne (remboursement rattaché à la date de la commande).",
      },
      {
        definition: "المبالغ المُعادة عن المرتجعات في المتجر المستلمة خلال الفترة.",
        calculation: "مجموع استردادات مرتجعات المتجر التي يقع تاريخ استلامها داخل الفترة.",
        period: "تاريخ استلام الإرجاع (receivedAt) وليس تاريخ البيع.",
        filters: STORE_FILTER.ar,
        example: `زبون أعاد في 20 سبتمبر قطعة اشتراها في 28 غشت: الـ${mad(EXAMPLE_STORE.refundsReceived)} المسترَدّة تُحتسب في سبتمبر.`,
        caveats: "على عكس الطلبات الإلكترونية (حيث يُنسب الاسترداد إلى تاريخ الطلب).",
      }
    ),
  },
  storeNetSales: {
    labels: ["CA net magasin"],
    sections: ["overview"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (netSales)",
    access: STORE,
    text: bi(
      {
        definition: "Le chiffre d'affaires du magasin après remboursements.",
        calculation: "CA brut magasin − remboursements (retours reçus sur la période).",
        period: "Ventes : date de vente ; remboursements : date de réception du retour.",
        filters: STORE_FILTER.fr,
        example: `${mad(storeGross)} − ${mad(EXAMPLE_STORE.refundsReceived)} = ${mad(storeGross - EXAMPLE_STORE.refundsReceived)}.`,
        caveats: "Mélange deux dates : une période peut porter le remboursement d'une vente plus ancienne.",
      },
      {
        definition: "رقم معاملات المتجر بعد الاستردادات.",
        calculation: "رقم معاملات المتجر الإجمالي − الاستردادات (المرتجعات المستلمة خلال الفترة).",
        period: "المبيعات: تاريخ البيع؛ الاستردادات: تاريخ استلام الإرجاع.",
        filters: STORE_FILTER.ar,
        example: `الإجمالي ${mad(storeGross)} − الاستردادات ${mad(EXAMPLE_STORE.refundsReceived)} = الصافي ${mad(storeGross - EXAMPLE_STORE.refundsReceived)}.`,
        caveats: "يجمع تاريخين مختلفين: قد تحمل الفترة استرداد بيع أقدم.",
      }
    ),
  },
  storeAverageTicket: {
    labels: ["Ticket moyen"],
    sections: ["overview"],
    source: "src/lib/analytics/queries/store.ts — getStoreOverview (averageSaleValue)",
    access: STORE,
    text: bi(
      {
        definition: "La valeur moyenne d'une vente en magasin.",
        calculation: "CA brut magasin ÷ nombre de ventes, arrondi à 0,01 (remboursements non déduits).",
        period: SOLD_AT.fr,
        filters: STORE_FILTER.fr,
        example: `${mad(storeGross)} ÷ ${EXAMPLE_STORE.sales.length} = ${mad(averageBasket(storeGross, EXAMPLE_STORE.sales.length) ?? 0)}.`,
      },
      {
        definition: "متوسط قيمة البيع في المتجر.",
        calculation: "رقم معاملات المتجر الإجمالي ÷ عدد المبيعات، مقرَّبًا إلى 0,01 (دون خصم الاستردادات).",
        period: SOLD_AT.ar,
        filters: STORE_FILTER.ar,
        example: `${mad(storeGross)} ÷ ${EXAMPLE_STORE.sales.length} مبيعات = ${mad(averageBasket(storeGross, EXAMPLE_STORE.sales.length) ?? 0)}.`,
      }
    ),
  },

  // ------------------------------------------------------------ Confirmation
  confirmationEntered: {
    labels: ["Entrées dans la confirmation"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (entered)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes arrivées dans la file de confirmation sur la période.",
        calculation: "Nombre de commandes passées sur la période, tous statuts — y compris celles saisies « client déjà confirmé » et les importations.",
        period: PLACED.fr,
        filters: `${ORIGIN_FILTER.fr} Le filtre « Confirmateur » ne change pas ce chiffre.`,
        example: `${E.orders} commandes passées → ${E.orders} entrées.`,
        interpretation: "Même nombre que « Commandes en ligne » pour les mêmes filtres.",
      },
      {
        definition: "الطلبات التي دخلت قائمة التأكيد خلال الفترة.",
        calculation: "عدد الطلبات المسجَّلة خلال الفترة بجميع الحالات، بما فيها الطلبات المُدخلة « client déjà confirmé » والمستوردة.",
        period: PLACED.ar,
        filters: `${ORIGIN_FILTER.ar} مرشّح « Confirmateur » لا يغيّر هذا الرقم.`,
        example: `${E.orders} طلبات مسجَّلة ← ${E.orders} مدخلات.`,
        interpretation: "الرقم نفسه الظاهر في « Commandes en ligne » بالمرشّحات نفسها.",
      }
    ),
  },
  cancelledBeforeConfirmation: {
    labels: ["Annulées avant confirmation"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (cancelledBeforeConfirmation)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes de la période annulées sans jamais avoir été confirmées.",
        calculation: "Commandes de la période au statut « Annulée » et sans date de confirmation.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `CMD-108, annulée au 2e appel → ${E.cancelledBeforeConfirmation}.`,
        interpretation: "Les pertes de la confirmation elle-même ; une commande confirmée puis annulée n'y figure pas.",
      },
      {
        definition: "طلبات الفترة التي أُلغيت دون أن تُؤكَّد أبدًا.",
        calculation: "طلبات الفترة بحالة « Annulée » وبلا تاريخ تأكيد.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `CMD-108 أُلغي في الاتصال رقم 2 ← ${E.cancelledBeforeConfirmation}.`,
        interpretation: "خسائر مرحلة التأكيد ذاتها؛ الطلب المؤكَّد ثم الملغى لا يظهر هنا.",
      }
    ),
  },
  confirmationAttempts: {
    labels: ["Tentatives d'appel"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (attempts, attemptsPerConfirmedOrder)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le nombre d'appels de confirmation enregistrés sur la période.",
        calculation: "Nombre de tentatives enregistrées (tous résultats). Sous le chiffre : tentatives ÷ tentatives au résultat « Confirmé », arrondi à 0,1.",
        period: "Date de la tentative (createdAt) — elle peut concerner une commande passée avant la période.",
        filters: "« Origine » filtre par commande ; « Confirmateur » ne garde que ses tentatives (numérateur et dénominateur).",
        example: `${EXAMPLE_ATTEMPTS_TOTAL} tentatives dont ${EXAMPLE_ATTEMPTS.CONFIRME} « Confirmé » → ${EXAMPLE_ATTEMPTS_TOTAL} ÷ ${EXAMPLE_ATTEMPTS.CONFIRME} = ${nf(Math.round((EXAMPLE_ATTEMPTS_TOTAL / EXAMPLE_ATTEMPTS.CONFIRME) * 10) / 10, 1)} tentative(s) par confirmation.`,
        interpretation: "La charge d'appels nécessaire pour obtenir une confirmation.",
      },
      {
        definition: "عدد اتصالات التأكيد المسجّلة خلال الفترة.",
        calculation: "عدد المحاولات المسجّلة (بجميع النتائج). تحت الرقم: المحاولات ÷ المحاولات ذات النتيجة « Confirmé »، مقرَّبًا إلى 0,1.",
        period: "تاريخ المحاولة (createdAt)، وقد تخصّ طلبًا مسجَّلًا قبل الفترة.",
        filters: "« Origine » يصفّي حسب الطلب؛ « Confirmateur » يحتفظ بمحاولاته فقط (البسط والمقام).",
        example: `${EXAMPLE_ATTEMPTS_TOTAL} محاولة منها ${EXAMPLE_ATTEMPTS.CONFIRME} « Confirmé » ← ${EXAMPLE_ATTEMPTS_TOTAL} ÷ ${EXAMPLE_ATTEMPTS.CONFIRME} = ${nf(Math.round((EXAMPLE_ATTEMPTS_TOTAL / EXAMPLE_ATTEMPTS.CONFIRME) * 10) / 10, 1)} محاولة لكل تأكيد.`,
        interpretation: "حجم الاتصالات اللازم للحصول على تأكيد واحد.",
      }
    ),
  },
  confirmationAvgTime: {
    labels: ["Délai moyen de confirmation"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (confirmationTime)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le temps moyen entre la commande et sa confirmation.",
        calculation: "Moyenne de (date de confirmation − date de commande) sur les commandes CONFIRMÉES pendant la période. Affiché en heures, en jours au-delà de 48 h.",
        period: "Date de confirmation (confirmedAt) dans la période.",
        filters: "« Origine » ; « Confirmateur » ne garde que les commandes qu'il a confirmées.",
        example: `3 commandes confirmées en 2 h, 6 h et 1 h → ${formatHours(avg(EXAMPLE_DURATIONS.confirmation))} (sur 3 commandes).`,
        caveats: "Une commande sans l'une des deux dates est exclue, jamais estimée. Une seule commande très lente tire la moyenne : comparez avec le délai médian.",
      },
      {
        definition: "متوسط المدة بين الطلب وتأكيده.",
        calculation: "متوسط (تاريخ التأكيد − تاريخ الطلب) للطلبات المؤكَّدة خلال الفترة. يُعرض بالساعات، وبالأيام إذا تجاوز 48 ساعة.",
        period: "تاريخ التأكيد (confirmedAt) داخل الفترة.",
        filters: "« Origine »؛ و« Confirmateur » يحتفظ بالطلبات التي أكّدها هو فقط.",
        example: `3 طلبات أُكِّدت في 2 س و6 س و1 س ← ${formatHours(avg(EXAMPLE_DURATIONS.confirmation))} (على 3 طلبات).`,
        caveats: "الطلب الذي ينقصه أحد التاريخين يُستبعد ولا يُقدَّر. طلب واحد بطيء جدًا يرفع المتوسط: قارنه بالمدة الوسيطة.",
      }
    ),
  },
  confirmationMedianTime: {
    labels: ["Délai médian de confirmation"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — durationOf (medianHours)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le délai « typique » de confirmation : la moitié des commandes est confirmée plus vite.",
        calculation: "Valeur du milieu des délais (date de confirmation − date de commande) triés ; moyenne des deux valeurs du milieu si leur nombre est pair.",
        period: "Date de confirmation dans la période.",
        filters: "Comme le délai moyen.",
        example: `Délais 1 h, 2 h, 6 h → médiane ${formatHours(median(EXAMPLE_DURATIONS.confirmation))} (la moyenne est ${formatHours(avg(EXAMPLE_DURATIONS.confirmation))}).`,
        interpretation: "Moins sensible qu'une moyenne aux cas extrêmes.",
      },
      {
        definition: "مدة التأكيد « النموذجية »: نصف الطلبات يُؤكَّد أسرع منها.",
        calculation: "القيمة الوسطى للمدد (تاريخ التأكيد − تاريخ الطلب) بعد ترتيبها؛ ومتوسط القيمتين الوسطيين إذا كان عددها زوجيًا.",
        period: "تاريخ التأكيد داخل الفترة.",
        filters: "مثل متوسط المدة.",
        example: `المدد 1 س و2 س و6 س ← الوسيط ${formatHours(median(EXAMPLE_DURATIONS.confirmation))} (والمتوسط ${formatHours(avg(EXAMPLE_DURATIONS.confirmation))}).`,
        interpretation: "أقل تأثّرًا بالحالات القصوى من المتوسط.",
      }
    ),
  },
  confirmedWithoutConfirmer: {
    labels: ["Confirmées sans confirmateur enregistré"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (confirmedWithoutConfirmer)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes confirmées sans tentative « Confirmé » enregistrée (importations, historique).",
        calculation: "Commandes confirmées pendant la période qui n'ont aucune tentative au résultat « Confirmé ».",
        period: "Date de confirmation dans la période.",
        filters: "« Origine ». Sans objet avec le filtre « Confirmateur ».",
        example: "Une commande Shopify importée déjà confirmée → comptée ici, attribuée à personne.",
        interpretation: "Explique pourquoi la somme des confirmations par confirmateur peut être inférieure aux confirmées.",
      },
      {
        definition: "الطلبات المؤكَّدة دون محاولة « Confirmé » مسجّلة (استيراد، سجلّ قديم).",
        calculation: "الطلبات المؤكَّدة خلال الفترة التي ليست لها أي محاولة بنتيجة « Confirmé ».",
        period: "تاريخ التأكيد داخل الفترة.",
        filters: "« Origine ». لا معنى له مع مرشّح « Confirmateur ».",
        example: "طلب Shopify مستورد ومؤكَّد مسبقًا ← يُحتسب هنا ولا يُنسب لأحد.",
        interpretation: "يفسّر لماذا قد يقلّ مجموع التأكيدات حسب المؤكِّدين عن عدد الطلبات المؤكَّدة.",
      }
    ),
  },
  confirmationSeries: {
    labels: ["Entrées, confirmées et tentatives"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (series)",
    access: ONLINE,
    text: bi(
      {
        definition: "Trois courbes par jour (ou par mois au-delà de 62 jours).",
        calculation: "Entrées et Confirmées : commandes placées au jour de leur date de commande (Confirmées = de cette même cohorte). Tentatives : placées au jour de l'appel.",
        period: "Date de commande pour les deux premières, date de la tentative pour la troisième.",
        filters: "Comme les cartes.",
        example: "Une commande du 3 confirmée le 4 : comptée en « Entrées » et « Confirmées » le 3 ; l'appel compte en « Tentatives » le 4.",
      },
      {
        definition: "ثلاثة منحنيات يوميًا (أو شهريًا إذا تجاوزت الفترة 62 يومًا).",
        calculation: "Entrées وConfirmées: الطلبات في يوم تاريخ الطلب (Confirmées من الفوج نفسه). Tentatives: في يوم الاتصال.",
        period: "تاريخ الطلب للمنحنيين الأوّلين، وتاريخ المحاولة للثالث.",
        filters: "مثل البطاقات.",
        example: "طلب بتاريخ 3 أُكِّد يوم 4: يُحتسب في « Entrées » و« Confirmées » يوم 3، والاتصال يُحتسب في « Tentatives » يوم 4.",
      }
    ),
  },
  attemptOutcomes: {
    labels: ["Résultats des tentatives"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (outcomes)",
    access: ONLINE,
    text: bi(
      {
        definition: "La répartition des appels de la période par résultat.",
        calculation: "Nombre de tentatives par résultat (Confirmé, Pas de réponse, Occupé, Rappeler, Faux numéro, Annulé) ; chaque barre = sa part du total des tentatives.",
        period: "Date de la tentative.",
        filters: "« Origine », « Confirmateur ».",
        example: `${EXAMPLE_ATTEMPTS.CONFIRME} Confirmé, ${EXAMPLE_ATTEMPTS.PAS_DE_REPONSE} Pas de réponse, ${EXAMPLE_ATTEMPTS.ANNULE} Annulé = ${EXAMPLE_ATTEMPTS_TOTAL} tentatives.`,
        interpretation: "Une commande appelée trois fois compte trois tentatives : ce sont des appels, pas des commandes.",
      },
      {
        definition: "توزيع اتصالات الفترة حسب النتيجة.",
        calculation: "عدد المحاولات لكل نتيجة (Confirmé، Pas de réponse، Occupé، Rappeler، Faux numéro، Annulé)؛ كل شريط = حصته من مجموع المحاولات.",
        period: "تاريخ المحاولة.",
        filters: "« Origine » و« Confirmateur ».",
        example: `${EXAMPLE_ATTEMPTS.CONFIRME} Confirmé، و${EXAMPLE_ATTEMPTS.PAS_DE_REPONSE} Pas de réponse، و${EXAMPLE_ATTEMPTS.ANNULE} Annulé = ${EXAMPLE_ATTEMPTS_TOTAL} محاولة.`,
        interpretation: "الطلب الذي اتُّصل به ثلاث مرات يُحتسب ثلاث محاولات: هذه اتصالات وليست طلبات.",
      }
    ),
  },
  confirmationByConfirmer: {
    labels: ["Par confirmateur"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (byConfirmer)",
    access: ONLINE,
    text: bi(
      {
        definition: "L'activité de chaque utilisateur qui a enregistré des appels.",
        calculation: "Par utilisateur ayant ENREGISTRÉ la tentative (jamais le créateur de la commande ni l'agent commissionné) : tentatives, « Confirmé », « Annulé », et délai moyen = moyenne de (date de sa tentative « Confirmé » − date de commande).",
        period: "Date de la tentative.",
        filters: "« Origine », « Confirmateur ».",
        example: "Amine : 6 tentatives, 4 confirmations, 1 annulation, délai moyen 3,5 h (4).",
        interpretation: "Un tableau factuel, sans score ni classement. Le nombre entre parenthèses est l'échantillon du délai.",
      },
      {
        definition: "نشاط كل مستخدم سجّل اتصالات.",
        calculation: "لكل مستخدم سجّل المحاولة (وليس منشئ الطلب ولا الوكيل صاحب العمولة): المحاولات، و« Confirmé »، و« Annulé »، ومتوسط المدة = متوسط (تاريخ محاولته « Confirmé » − تاريخ الطلب).",
        period: "تاريخ المحاولة.",
        filters: "« Origine » و« Confirmateur ».",
        example: "Amine: 6 محاولات، 4 تأكيدات، 1 إلغاء، متوسط المدة 3,5 س (4).",
        interpretation: "جدول وقائعي دون تنقيط أو ترتيب. الرقم بين قوسين هو حجم العيّنة للمدة.",
      }
    ),
  },
  confirmationBySource: {
    labels: ["Par origine"],
    sections: ["confirmation"],
    source: "src/lib/analytics/queries/online.ts — getConfirmationAnalytics (bySource)",
    access: ONLINE,
    text: bi(
      {
        definition: "Entrées, confirmées et taux de confirmation par origine de commande.",
        calculation: "Mêmes définitions que les cartes, regroupées par origine (WooCommerce, Shopify, ou canal de la commande manuelle ; « Autre » si aucun). Taux = confirmées ÷ passées par la confirmation, dans l'origine.",
        period: PLACED.fr,
        filters: "« Origine ».",
        example: "WhatsApp : 4 entrées, 3 confirmées, 4 appelées → 75,0 %.",
      },
      {
        definition: "المدخلات والمؤكَّدة ونسبة التأكيد حسب مصدر الطلب.",
        calculation: "التعريفات نفسها المعتمدة في البطاقات، مجمّعة حسب المصدر (WooCommerce أو Shopify أو قناة الطلب اليدوي؛ « Autre » إن لم توجد). النسبة = المؤكَّدة ÷ التي مرّت بالتأكيد، داخل المصدر.",
        period: PLACED.ar,
        filters: "مرشّح « Origine ».",
        example: "WhatsApp: 4 مدخلات، 3 مؤكَّدة، 4 اتُّصل بها ← 75,0 %.",
      }
    ),
  },

  // ------------------------------------------------------------ Livraison
  shippedOrders: {
    labels: ["Expédiées"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (overall.shipped)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes en ligne expédiées pendant la période.",
        calculation: "Nombre de commandes dont la date d'expédition est dans la période (une ligne par commande, même après plusieurs tentatives). Sous le chiffre : combien sont encore en cours.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `CMD-101 à 106 expédiées en septembre → ${E.shipped} expédiées, ${E.inProgress} encore en cours (CMD-104).`,
        caveats: "Une commande importée déjà livrée sans date d'expédition n'apparaît pas (aucune date à rattacher).",
      },
      {
        definition: "الطلبات الإلكترونية المشحونة خلال الفترة.",
        calculation: "عدد الطلبات التي يقع تاريخ شحنها داخل الفترة (سطر واحد لكل طلب حتى بعد عدة محاولات). تحت الرقم: عدد الطلبات التي ما زالت جارية.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `الطلبات من CMD-101 إلى 106 شُحنت في سبتمبر ← ${E.shipped} مشحونة، و${E.inProgress} ما زال جاريًا (CMD-104).`,
        caveats: "الطلب المستورد المسلَّم مسبقًا دون تاريخ شحن لا يظهر (لا يوجد تاريخ يُنسب إليه).",
      }
    ),
  },
  deliveryDelivered: {
    labels: ["Livrées"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (deliveryOutcomeOf)",
    access: ONLINE,
    text: bi(
      {
        definition: "Parmi les commandes expédiées sur la période, celles livrées.",
        calculation: `Commandes expédiées sur la période dont le résultat final est « livrée ». ${OUTCOME_RULE.fr}`,
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `CMD-101, 102, 103 → ${E.delivered} livrées.`,
        caveats: "Population différente de « Commandes livrées » (Vue d'ensemble), qui part des commandes PASSÉES sur la période.",
      },
      {
        definition: "من بين الطلبات المشحونة خلال الفترة، تلك التي سُلِّمت.",
        calculation: `الطلبات المشحونة خلال الفترة التي نتيجتها النهائية « livrée ». ${OUTCOME_RULE.ar}`,
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `CMD-101 و102 و103 ← ${E.delivered} مسلَّمة.`,
        caveats: "مجموعة مختلفة عن « Commandes livrées » (Vue d'ensemble) التي تنطلق من الطلبات المسجَّلة خلال الفترة.",
      }
    ),
  },
  deliveryFailed: {
    labels: ["Échecs"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics",
    access: ONLINE,
    text: bi(
      {
        definition: "Commandes expédiées sur la période dont la livraison a finalement échoué.",
        calculation: `Résultat final « échec ». ${OUTCOME_RULE.fr}`,
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `CMD-105 → ${E.failed}.`,
      },
      {
        definition: "الطلبات المشحونة خلال الفترة التي فشل تسليمها في النهاية.",
        calculation: `النتيجة النهائية « échec ». ${OUTCOME_RULE.ar}`,
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `الطلب CMD-105 ← ${E.failed} فاشل.`,
      }
    ),
  },
  deliveryReturned: {
    labels: ["Retournées"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics",
    access: ONLINE,
    text: bi(
      {
        definition: "Commandes expédiées sur la période revenues (colis retourné, ou commande Retour / Remboursée).",
        calculation: `Résultat final « retournée ». ${OUTCOME_RULE.fr}`,
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `CMD-106 → ${E.returned}.`,
      },
      {
        definition: "الطلبات المشحونة خلال الفترة التي عادت (طرد مُرجَع، أو طلب Retour / Remboursée).",
        calculation: `النتيجة النهائية « retournée ». ${OUTCOME_RULE.ar}`,
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `الطلب CMD-106 ← ${E.returned} مُرجَع.`,
      }
    ),
  },
  deliveryTabRate: {
    labels: ["Taux de livraison"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — deliveryRow (deliveryOutcomeRate)",
    access: ONLINE,
    text: bi(
      {
        definition: "La part des commandes expédiées ayant une issue qui ont été livrées.",
        calculation: "Livrées ÷ (livrées + échecs + retournées) × 100. « En cours » est hors calcul.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `${E.delivered} ÷ (${E.delivered} + ${E.failed} + ${E.returned}) = ${pct(E.deliveryRate)}.`,
        caveats: "Même formule que « Taux de livraison réussie », sur les commandes EXPÉDIÉES (et non passées) dans la période. Sans aucune issue, affiché « Aucune expédition » même si des colis sont en route.",
      },
      {
        definition: "نسبة الطلبات المشحونة المعروفة نتيجتها التي تمّ تسليمها.",
        calculation: "المسلَّمة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100. « En cours » خارج الحساب.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `${E.delivered} مسلَّمة ÷ (${E.delivered} + ${E.failed} + ${E.returned}) طلبات لها نتيجة = ${pct(E.deliveryRate)}.`,
        caveats: "الصيغة نفسها المعتمدة في « Taux de livraison réussie » لكن على الطلبات المشحونة (لا المسجَّلة) خلال الفترة. إن لم توجد أي نتيجة يظهر « Aucune expédition » حتى لو كانت طرود في الطريق.",
      }
    ),
  },
  failureRate: {
    labels: ["Taux d'échec"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — deliveryRow (failureRate)",
    access: ONLINE,
    text: bi(
      {
        definition: "La part des commandes expédiées ayant une issue qui ont échoué.",
        calculation: "Échecs ÷ (livrées + échecs + retournées) × 100, à 0,1 près.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `${E.failed} ÷ ${E.delivered + E.failed + E.returned} = ${pct(E.failureRate)}.`,
        interpretation: "Taux de livraison + taux d'échec + taux de retour = 100 % (aux arrondis près).",
      },
      {
        definition: "نسبة الطلبات المشحونة المعروفة نتيجتها التي فشل تسليمها.",
        calculation: "الفاشلة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100، مقرَّبًا إلى 0,1.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `${E.failed} فاشل ÷ ${E.delivered + E.failed + E.returned} طلبات لها نتيجة = ${pct(E.failureRate)}.`,
        interpretation: "نسبة التسليم + نسبة الفشل + نسبة الإرجاع = 100 % (مع فارق التقريب).",
      }
    ),
  },
  returnRate: {
    labels: ["Taux de retour"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — deliveryRow (returnRate)",
    access: ONLINE,
    text: bi(
      {
        definition: "La part des commandes expédiées ayant une issue qui sont revenues.",
        calculation: "Retournées ÷ (livrées + échecs + retournées) × 100, à 0,1 près.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `${E.returned} ÷ ${E.delivered + E.failed + E.returned} = ${pct(E.returnRate)}.`,
      },
      {
        definition: "نسبة الطلبات المشحونة المعروفة نتيجتها التي عادت.",
        calculation: "المُرجَعة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100، مقرَّبًا إلى 0,1.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `${E.returned} مُرجَع ÷ ${E.delivered + E.failed + E.returned} طلبات لها نتيجة = ${pct(E.returnRate)}.`,
      }
    ),
  },
  deliveryInProgress: {
    labels: ["En cours"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (inProgress)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les commandes expédiées sur la période sans issue connue (indication « encore en cours » et barre « En cours »).",
        calculation: "Expédiées − livrées − échecs − retournées.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `${E.shipped} − ${E.delivered} − ${E.failed} − ${E.returned} = ${E.inProgress} (CMD-104, en transit).`,
      },
      {
        definition: "الطلبات المشحونة خلال الفترة دون نتيجة معروفة (إشارة « encore en cours » وشريط « En cours »).",
        calculation: "المشحونة − المسلَّمة − الفاشلة − المُرجَعة.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `${E.shipped} − ${E.delivered} − ${E.failed} − ${E.returned} = ${E.inProgress} (CMD-104، في الطريق).`,
      }
    ),
  },
  confirmedToShipped: {
    labels: ["Confirmée → expédiée"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (confirmedToShipped)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le temps moyen de préparation, de la confirmation à l'expédition.",
        calculation: "Moyenne de (date d'expédition − date de confirmation) sur les commandes expédiées de la période qui portent les deux dates. Sous le chiffre : la taille de l'échantillon.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `6 commandes : ${EXAMPLE_DURATIONS.confirmedToShipped.join(", ")} h → ${formatHours(avg(EXAMPLE_DURATIONS.confirmedToShipped))} (moyenne sur 6).`,
        caveats: "Une date manquante exclut la commande ; aucun délai n'est estimé.",
      },
      {
        definition: "متوسط مدة التحضير، من التأكيد إلى الشحن.",
        calculation: "متوسط (تاريخ الشحن − تاريخ التأكيد) للطلبات المشحونة خلال الفترة التي تحمل التاريخين. تحت الرقم: حجم العيّنة.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `6 طلبات: ${EXAMPLE_DURATIONS.confirmedToShipped.join("، ")} س ← ${formatHours(avg(EXAMPLE_DURATIONS.confirmedToShipped))} (متوسط على 6).`,
        caveats: "غياب أحد التاريخين يستبعد الطلب؛ ولا تُقدَّر أي مدة.",
      }
    ),
  },
  shippedToDelivered: {
    labels: ["Expédiée → livrée"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (shippedToDelivered)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le temps moyen de transport, de l'expédition à la livraison.",
        calculation: "Moyenne de (date de livraison − date d'expédition) sur les commandes expédiées de la période au statut « Livrée » portant les deux dates. Aussi affiché par transporteur.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `3 livraisons en ${EXAMPLE_DURATIONS.shippedToDelivered.join(", ")} h → ${formatHours(avg(EXAMPLE_DURATIONS.shippedToDelivered))}.`,
        caveats: "Ne retient que les commandes au statut « Livrée » (le compteur « Livrées » se base, lui, sur le résultat de la dernière expédition).",
      },
      {
        definition: "متوسط مدة النقل، من الشحن إلى التسليم.",
        calculation: "متوسط (تاريخ التسليم − تاريخ الشحن) للطلبات المشحونة خلال الفترة ذات الحالة « Livrée » والتي تحمل التاريخين. يُعرض أيضًا حسب شركة التوصيل.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `3 عمليات تسليم في ${EXAMPLE_DURATIONS.shippedToDelivered.join("، ")} س ← ${formatHours(avg(EXAMPLE_DURATIONS.shippedToDelivered))}.`,
        caveats: "لا يأخذ إلا الطلبات بحالة « Livrée » (بينما يعتمد عدّاد « Livrées » على نتيجة آخر شحنة).",
      }
    ),
  },
  confirmedToDelivered: {
    labels: ["Confirmée → livrée"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (confirmedToDelivered)",
    access: ONLINE,
    text: bi(
      {
        definition: "Le temps total entre la confirmation et la livraison.",
        calculation: "Moyenne de (date de livraison − date de confirmation) sur les commandes expédiées de la période au statut « Livrée » portant les deux dates.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: "Confirmée lundi 10 h, livrée jeudi 10 h → 72 h, soit 3,0 j.",
        caveats: "Ce n'est pas la somme des deux autres moyennes : les échantillons diffèrent.",
      },
      {
        definition: "المدة الكاملة بين التأكيد والتسليم.",
        calculation: "متوسط (تاريخ التسليم − تاريخ التأكيد) للطلبات المشحونة خلال الفترة ذات الحالة « Livrée » والتي تحمل التاريخين.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: "أُكِّد يوم الإثنين 10 صباحًا وسُلِّم يوم الخميس 10 صباحًا ← 72 س، أي 3,0 j.",
        caveats: "ليس مجموع المتوسطين الآخرين: العيّنات مختلفة.",
      }
    ),
  },
  deliverySeries: {
    labels: ["Expéditions et issues — par date d'expédition"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (series)",
    access: ONLINE,
    text: bi(
      {
        definition: "Expédiées, livrées, échecs et retournées, au jour d'expédition.",
        calculation: "Chaque commande est placée au jour de sa date d'expédition ; son issue (même survenue plus tard) est comptée ce même jour.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: "Expédiée le 5, livrée le 8 → compte en « Expédiées » et en « Livrées » le 5.",
      },
      {
        definition: "المشحونة والمسلَّمة والفاشلة والمُرجَعة حسب يوم الشحن.",
        calculation: "يوضع كل طلب في يوم تاريخ شحنه، وتُحتسب نتيجته (ولو حصلت لاحقًا) في اليوم نفسه.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: "شُحن يوم 5 وسُلِّم يوم 8 ← يُحتسب في « Expédiées » و« Livrées » يوم 5.",
      }
    ),
  },
  deliveryOutcomeBreakdown: {
    labels: ["Issue des expéditions"],
    sections: ["delivery"],
    source: "src/app/(protected)/analyses/livraison/page.tsx — BreakdownBarList",
    access: ONLINE,
    text: bi(
      {
        definition: "La répartition des commandes expédiées de la période par issue.",
        calculation: "Livrées, Échecs, Retournées, En cours ; chaque barre = sa part des expédiées (la somme fait 100 %).",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: `${E.delivered} / ${E.failed} / ${E.returned} / ${E.inProgress} sur ${E.shipped} → 50 % / 16,7 % / 16,7 % / 16,7 %.`,
        caveats: "Ici le dénominateur INCLUT les commandes en cours ; dans les taux, non.",
      },
      {
        definition: "توزيع الطلبات المشحونة خلال الفترة حسب النتيجة.",
        calculation: "Livrées وÉchecs وRetournées وEn cours؛ كل شريط = حصته من المشحونة (المجموع 100 %).",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: `${E.delivered} / ${E.failed} / ${E.returned} / ${E.inProgress} من ${E.shipped} ← 50 % / 16,7 % / 16,7 % / 16,7 %.`,
        caveats: "هنا يشمل المقامُ الطلباتِ الجارية؛ أما في النسب فلا.",
      }
    ),
  },
  deliveryByProvider: {
    labels: ["Par transporteur"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (byProvider)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les mêmes indicateurs, par transporteur.",
        calculation: "Transporteur = celui de la DERNIÈRE expédition réelle de la commande. Colonnes : expédiées, livrées, échecs, retournées, taux de livraison, délai expédiée → livrée — mêmes règles que les cartes.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: "Colis échoué chez A puis renvoyé et livré chez B → 1 commande, livrée, chez B.",
        caveats: "« Sans transporteur » : commandes expédiées sans expédition enregistrée.",
      },
      {
        definition: "المؤشرات نفسها حسب شركة التوصيل.",
        calculation: "شركة التوصيل = شركة آخر شحنة فعلية للطلب. الأعمدة: المشحونة والمسلَّمة والفاشلة والمُرجَعة ونسبة التسليم ومدة الشحن ← التسليم، بالقواعد نفسها المعتمدة في البطاقات.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: "طرد فشل لدى A ثم أُعيد إرساله وسُلِّم لدى B ← 1 طلب، مسلَّم، لدى B.",
        caveats: "« Sans transporteur »: طلبات مشحونة دون شحنة مسجّلة.",
      }
    ),
  },
  deliveryBySource: {
    labels: ["Par origine"],
    sections: ["delivery"],
    source: "src/lib/analytics/queries/online.ts — getDeliveryAnalytics (bySource)",
    access: ONLINE,
    text: bi(
      {
        definition: "Les mêmes indicateurs, par origine de commande.",
        calculation: "Commandes expédiées sur la période regroupées par origine ; mêmes colonnes et règles que les cartes.",
        period: SHIPPED_AT.fr,
        filters: DELIVERY_FILTER.fr,
        example: "Instagram : 10 expédiées, 7 livrées, 2 échecs, 1 en cours → 7 ÷ 9 = 77,8 %.",
      },
      {
        definition: "المؤشرات نفسها حسب مصدر الطلب.",
        calculation: "الطلبات المشحونة خلال الفترة مجمّعة حسب المصدر، بالأعمدة والقواعد نفسها المعتمدة في البطاقات.",
        period: SHIPPED_AT.ar,
        filters: DELIVERY_FILTER.ar,
        example: "Instagram: 10 مشحونة، 7 مسلَّمة، 2 فاشلة، 1 جارٍ ← 7 ÷ 9 = 77,8 %.",
      }
    ),
  },

  // ------------------------------------------------------------ Produits
  productUnits: {
    labels: ["Unités"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — build (units)",
    access: `${ONLINE} / ${STORE}`,
    text: bi(
      {
        definition: "Quantité vendue du produit / de la variation.",
        calculation: "En ligne : somme des quantités des lignes des commandes valides passées sur la période. Magasin : somme des quantités des lignes des ventes de la période.",
        scope: `${REVENUE_EXCLUDED.fr} Magasin : vos magasins et emplacements.`,
        period: "En ligne : date de commande. Magasin : date de vente.",
        filters: "Origine (en ligne), Magasin et Emplacement (magasin), Catégorie (les deux).",
        example: `Sac Atlas : CMD-101 (2) + 103 (1) + 107 (1) + 110 (1) = ${sac.units}. CMD-105 (2, en échec) ne compte pas.`,
      },
      {
        definition: "الكمية المبيعة من المنتج / المتغيّر.",
        calculation: "إلكترونيًا: مجموع كميات أسطر الطلبات الصالحة المسجَّلة خلال الفترة. في المتجر: مجموع كميات أسطر مبيعات الفترة.",
        scope: `${REVENUE_EXCLUDED.ar} المتجر: متاجرك ومواقعك.`,
        period: "إلكترونيًا: تاريخ الطلب. في المتجر: تاريخ البيع.",
        filters: "Origine (إلكترونيًا)، وMagasin وEmplacement (المتجر)، وCatégorie (كلاهما).",
        example: `Sac Atlas: CMD-101 (2) + 103 (1) + 107 (1) + 110 (1) = ${sac.units}. الطلب CMD-105 (2، فاشل) لا يُحتسب.`,
      }
    ),
  },
  productOrders: {
    labels: ["Commandes", "Ventes"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — build (orders = distinct parents)",
    access: `${ONLINE} / ${STORE}`,
    text: bi(
      {
        definition: "Le nombre de commandes (en ligne) ou de ventes (magasin) distinctes contenant le produit.",
        calculation: "Nombre de commandes / ventes distinctes ayant au moins une ligne du produit ; une commande avec 3 unités compte 1.",
        period: "En ligne : date de commande. Magasin : date de vente.",
        filters: "Comme « Unités ».",
        example: `Sac Atlas : ${sac.units} unités dans ${sac.orders} commandes (CMD-101 en contient 2).`,
        caveats: "Le total par catégorie compte chaque commande une fois, même si elle contient plusieurs produits de la catégorie.",
      },
      {
        definition: "عدد الطلبات (إلكترونيًا) أو عمليات البيع (في المتجر) المتميّزة التي تتضمّن المنتج.",
        calculation: "عدد الطلبات / عمليات البيع المتميّزة التي فيها سطر واحد على الأقل من المنتج؛ الطلب الذي فيه 3 قطع يُحتسب مرة واحدة.",
        period: "إلكترونيًا: تاريخ الطلب. في المتجر: تاريخ البيع.",
        filters: "مثل « Unités ».",
        example: `Sac Atlas: ${sac.units} قطع في ${sac.orders} طلبات (CMD-101 يتضمّن 2 منها).`,
        caveats: "مجموع الفئة يحتسب كل طلب مرة واحدة حتى لو تضمّن عدة منتجات من الفئة.",
      }
    ),
  },
  productRevenue: {
    labels: ["CA"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — build (revenue = Σ line totals)",
    access: `${ONLINE} / ${STORE}`,
    text: bi(
      {
        definition: "Les ventes du produit, hors frais de livraison.",
        calculation: "Somme des totaux de ligne (prix × quantité, remise de ligne déduite). Ni frais de livraison, ni remises globales, ni remboursements.",
        period: "En ligne : date de commande. Magasin : date de vente.",
        filters: "Comme « Unités ».",
        example: `Sac Atlas ${mad(sac.revenue)} + Foulard Rif ${mad(E.products[1].revenue)} + Ceinture Fès ${mad(E.products[2].revenue)} = ${mad(E.productRevenue)}, soit le brut (${mad(E.grossRevenue)}) moins ${mad(E.shippingFees)} de frais de livraison.`,
        caveats: "Les remboursements sont enregistrés par commande, pas par produit : ils ne peuvent pas être déduits ici.",
      },
      {
        definition: "مبيعات المنتج دون رسوم التوصيل.",
        calculation: "مجموع مبالغ الأسطر (السعر × الكمية بعد خصم تخفيض السطر). دون رسوم التوصيل ولا التخفيضات الشاملة ولا الاستردادات.",
        period: "إلكترونيًا: تاريخ الطلب. في المتجر: تاريخ البيع.",
        filters: "مثل « Unités ».",
        example: `Sac Atlas ${mad(sac.revenue)} + Foulard Rif ${mad(E.products[1].revenue)} + Ceinture Fès ${mad(E.products[2].revenue)} = ${mad(E.productRevenue)}، أي الإجمالي (${mad(E.grossRevenue)}) ناقص ${mad(E.shippingFees)} رسوم توصيل.`,
        caveats: "الاستردادات تُسجَّل على مستوى الطلب لا المنتج، فلا يمكن خصمها هنا.",
      }
    ),
  },
  productReturnedUnits: {
    labels: ["Unités retournées"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — getOnlineProductPerformance / getStoreProductPerformance (returns)",
    access: `${ONLINE} / ${STORE}`,
    text: bi(
      {
        definition: "Les unités physiquement revenues (réception de retour) pendant la période.",
        calculation: "Somme des quantités reçues, revendables + endommagées, des retours réceptionnés.",
        period: "Date de réception du retour (receivedAt) — le retour peut concerner une commande d'une période antérieure.",
        filters: "Comme « Unités ».",
        example: `Retour de CMD-106 reçu en septembre : ${E.returnedUnits.sellable} revendables + ${E.returnedUnits.damaged} endommagé = 3 Foulard Rif retournés, alors que CMD-106 n'est pas dans les unités vendues.`,
        caveats: "Ne se soustrait pas des unités vendues : les deux n'ont ni la même date ni la même population.",
      },
      {
        definition: "القطع التي عادت فعليًا (استلام الإرجاع) خلال الفترة.",
        calculation: "مجموع الكميات المستلمة من المرتجعات، الصالحة لإعادة البيع + التالفة.",
        period: "تاريخ استلام الإرجاع (receivedAt)، وقد يخصّ الإرجاع طلبًا من فترة سابقة.",
        filters: "مثل « Unités ».",
        example: `إرجاع CMD-106 المستلم في سبتمبر: ${E.returnedUnits.sellable} صالحة + ${E.returnedUnits.damaged} تالفة = 3 قطع Foulard Rif مُرجَعة، مع أن CMD-106 غير محتسب في القطع المبيعة.`,
        caveats: "لا تُطرح من القطع المبيعة: لا يتشاركان التاريخ ولا المجموعة.",
      }
    ),
  },
  productCost: {
    labels: ["Coût"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — build (cogs, withFinance)",
    access: `${FINANCE} (colonne absente sinon)`,
    text: bi(
      {
        definition: "Le coût d'achat des unités vendues.",
        calculation: "Σ (coût figé sur la ligne au moment de la vente × quantité).",
        period: "Comme « Unités ».",
        filters: "Comme « Unités ».",
        example: `Sac Atlas : ${sac.units} × 60 = ${mad(sac.cost)}.`,
        caveats: "« — » si une seule ligne n'a pas de coût figé. Colonne affichée uniquement avec l'accès Finance.",
      },
      {
        definition: "كلفة شراء القطع المبيعة.",
        calculation: "Σ (الكلفة المثبّتة على السطر لحظة البيع × الكمية).",
        period: "مثل « Unités ».",
        filters: "مثل « Unités ».",
        example: `كلفة Sac Atlas: ${sac.units} × 60 = ${mad(sac.cost)}.`,
        caveats: "يظهر « — » إذا كان سطر واحد بلا كلفة مثبّتة. لا يظهر العمود إلا مع صلاحية المالية.",
      }
    ),
  },
  productGrossProfit: {
    labels: ["Bénéfice brut"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — build (grossProfit)",
    access: `${FINANCE} (colonne absente sinon)`,
    text: bi(
      {
        definition: "Ce que le produit laisse après son coût d'achat.",
        calculation: "CA (lignes) − coût.",
        period: "Comme « Unités ».",
        filters: "Comme « Unités ».",
        example: `Sac Atlas : ${mad(sac.revenue)} − ${mad(sac.cost)} = ${mad(sac.grossProfit)}.`,
        caveats: "Différent du « Bénéfice brut » de la Vue d'ensemble, qui part du chiffre d'affaires net (remboursements déduits, livraison facturée comprise).",
      },
      {
        definition: "ما يتركه المنتج بعد كلفة شرائه.",
        calculation: "رقم معاملات الأسطر − الكلفة.",
        period: "مثل « Unités ».",
        filters: "مثل « Unités ».",
        example: `ربح Sac Atlas: ${mad(sac.revenue)} − ${mad(sac.cost)} = ${mad(sac.grossProfit)}.`,
        caveats: "يختلف عن « Bénéfice brut » في Vue d'ensemble الذي ينطلق من رقم المعاملات الصافي (بعد الاستردادات ومع رسوم التوصيل المفوترة).",
      }
    ),
  },
  productCategories: {
    labels: ["En ligne — par catégorie", "Magasin — par catégorie"],
    sections: ["products"],
    source: "src/lib/analytics/queries/products.ts — build (categories)",
    access: `${ONLINE} / ${STORE}`,
    text: bi(
      {
        definition: "Les mêmes colonnes, additionnées par catégorie de produit.",
        calculation: "Somme des lignes des produits de la catégorie ; « Commandes » / « Ventes » = commandes distinctes de la catégorie. « Sans catégorie » regroupe les produits sans catégorie ou supprimés.",
        period: "Comme « Unités ».",
        filters: "Comme « Unités ».",
        example: "Catégorie Accessoires = Foulard Rif + Ceinture Fès : CMD-103 contient les deux et compte une seule fois.",
      },
      {
        definition: "الأعمدة نفسها مجمّعة حسب فئة المنتج.",
        calculation: "مجموع أسطر منتجات الفئة؛ « Commandes » / « Ventes » = الطلبات المتميّزة في الفئة. « Sans catégorie » يجمع المنتجات بلا فئة أو المحذوفة.",
        period: "مثل « Unités ».",
        filters: "مثل « Unités ».",
        example: "فئة Accessoires = Foulard Rif + Ceinture Fès: الطلب CMD-103 يتضمّنهما معًا ويُحتسب مرة واحدة.",
      }
    ),
  },

  // ------------------------------------------------------------ Origines & magasins
  ordersByOrigin: {
    labels: ["Commandes en ligne par origine"],
    sections: ["sources"],
    source: "src/lib/analytics/queries/online.ts — getOnlineSourceFunnel (orders)",
    access: ONLINE,
    text: bi(
      {
        definition: "La répartition des commandes de la période par origine.",
        calculation: "Nombre de commandes par origine : WooCommerce, Shopify, ou le canal saisi sur une commande manuelle (WhatsApp, Instagram, Téléphone…), « Autre » si aucun. Chaque barre = sa part du total.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: "6 WhatsApp et 4 Shopify sur 10 → 60 % / 40 %.",
        interpretation: "L'origine dit d'où vient la commande ; elle ne dit pas d'où elle a été expédiée (les commandes en ligne n'ont pas d'emplacement d'origine dans ces analyses).",
      },
      {
        definition: "توزيع طلبات الفترة حسب المصدر.",
        calculation: "عدد الطلبات لكل مصدر: WooCommerce أو Shopify أو القناة المُدخلة على الطلب اليدوي (WhatsApp، Instagram، الهاتف…)، و« Autre » إن لم توجد. كل شريط = حصته من المجموع.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: "6 من WhatsApp و4 من Shopify من أصل 10 ← 60 % / 40 %.",
        interpretation: "المصدر يبيّن من أين جاء الطلب، ولا يبيّن من أين شُحن (الطلبات الإلكترونية ليس لها موقع منشأ في هذه التحليلات).",
      }
    ),
  },
  originFunnel: {
    labels: ["Entonnoir par origine"],
    sections: ["sources"],
    source: "src/lib/analytics/queries/online.ts — getOnlineSourceFunnel",
    access: ONLINE,
    text: bi(
      {
        definition: "L'entonnoir complet des commandes de la période, origine par origine.",
        calculation: "Par origine, sur les commandes passées : Commandes, Confirmées, Expédiées, Livrées, Retournées, Annulées — mêmes définitions que la Vue d'ensemble ; Taux conf. = confirmées ÷ passées par la confirmation ; Taux livr. = livrées ÷ (livrées + échecs + retournées) ; Chiffre d'affaires = net, remboursements déduits.",
        period: PLACED.fr,
        filters: ORIGIN_FILTER.fr,
        example: `Pour toute la Boutique Exemple, la ligne serait : ${E.orders} / ${E.confirmed} / ${E.shipped} / ${E.delivered} / ${E.returned} / ${E.cancelled}, ${pct(E.confirmationRate)}, ${pct(E.deliveryRate)}, ${mad(E.netRevenue)}.`,
        caveats: "Les échecs n'ont pas de colonne mais pèsent dans le taux de livraison (ils sont dans l'export CSV).",
      },
      {
        definition: "المسار الكامل لطلبات الفترة، مصدرًا بمصدر.",
        calculation: "لكل مصدر، على الطلبات المسجَّلة: Commandes وConfirmées وExpédiées وLivrées وRetournées وAnnulées بالتعريفات نفسها المعتمدة في Vue d'ensemble؛ Taux conf. = المؤكَّدة ÷ التي مرّت بالتأكيد؛ Taux livr. = المسلَّمة ÷ (المسلَّمة + الفاشلة + المُرجَعة)؛ Chiffre d'affaires = صافٍ بعد الاستردادات.",
        period: PLACED.ar,
        filters: ORIGIN_FILTER.ar,
        example: `بالنسبة لـBoutique Exemple كلها يكون السطر: ${E.orders} / ${E.confirmed} / ${E.shipped} / ${E.delivered} / ${E.returned} / ${E.cancelled}، ${pct(E.confirmationRate)}، ${pct(E.deliveryRate)}، ${mad(E.netRevenue)}.`,
        caveats: "حالات الفشل ليس لها عمود لكنها تدخل في نسبة التسليم (وهي موجودة في تصدير CSV).",
      }
    ),
  },
  storeByStore: {
    labels: ["Ventes en magasin par magasin"],
    sections: ["sources"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (byChannel)",
    access: STORE,
    text: bi(
      {
        definition: "Ventes et CA brut de chaque magasin.",
        calculation: "Par magasin (canal de vente hors ligne) : nombre de ventes et somme de leurs totaux. Pas d'entonnoir : une vente en magasin n'a ni confirmation ni livraison.",
        period: SOLD_AT.fr,
        filters: STORE_FILTER.fr,
        example: EXAMPLE_STORE.byStore.map((s) => `${s.name} : ${s.sales} vente(s), ${mad(s.gross)}`).join(" ; ") + ".",
        caveats: "CA brut : les remboursements ne sont pas répartis par magasin ici.",
      },
      {
        definition: "المبيعات ورقم المعاملات الإجمالي لكل متجر.",
        calculation: "لكل متجر (قناة بيع غير إلكترونية): عدد المبيعات ومجموع مبالغها. لا يوجد مسار: البيع في المتجر ليس له تأكيد ولا توصيل.",
        period: SOLD_AT.ar,
        filters: STORE_FILTER.ar,
        example: EXAMPLE_STORE.byStore.map((s) => `${s.name}: ${s.sales} عملية بيع، ${mad(s.gross)}`).join("؛ ") + ".",
        caveats: "رقم معاملات إجمالي: الاستردادات غير موزّعة على المتاجر هنا.",
      }
    ),
  },
  storeByLocation: {
    labels: ["Ventes en magasin par emplacement"],
    sections: ["sources"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (byLocation)",
    access: STORE,
    text: bi(
      {
        definition: "Ventes et CA brut par emplacement (le stock d'où la vente est sortie).",
        calculation: "Par emplacement de la vente : nombre de ventes et somme de leurs totaux.",
        period: SOLD_AT.fr,
        filters: STORE_FILTER.fr,
        example: "Un magasin servi par deux emplacements (boutique et réserve) apparaît sur deux lignes ici, sur une seule dans « par magasin ».",
        interpretation: "Le magasin est le point de vente ; l'emplacement est le stock physique. L'origine d'une commande en ligne est une troisième notion (d'où vient le client).",
      },
      {
        definition: "المبيعات ورقم المعاملات الإجمالي حسب الموقع (المخزون الذي خرج منه البيع).",
        calculation: "لكل موقع بيع: عدد المبيعات ومجموع مبالغها.",
        period: SOLD_AT.ar,
        filters: STORE_FILTER.ar,
        example: "متجر يُزوَّد من موقعين (المحل والمخزن) يظهر في سطرين هنا، وفي سطر واحد في « par magasin ».",
        interpretation: "المتجر هو نقطة البيع، والموقع هو المخزون الفعلي. ومصدر الطلب الإلكتروني مفهوم ثالث (من أين جاء الزبون).",
      }
    ),
  },

  // ------------------------------------------------------------ Commissions
  commissionSeries: {
    labels: ["Par période"],
    sections: ["commissions"],
    source: "src/lib/analytics/queries/commissions.ts — getCommissionAnalytics (series)",
    access: COMMISSIONS,
    text: bi(
      {
        definition: "Commissions gagnées et annulées, jour par jour (mois par mois au-delà de 62 jours).",
        calculation: "Chaque écriture est placée au jour de sa date d'écriture.",
        period: ENTRY_DATE.fr,
        filters: COMMISSION_FILTER.fr,
        example: `Le 12 : 2 livraisons à ${EXAMPLE_COMMISSION.ratePerOrder} MAD → 20 MAD gagnés ce jour-là.`,
      },
      {
        definition: "العمولات المستحقة والملغاة يومًا بيوم (وشهرًا بشهر إذا تجاوزت الفترة 62 يومًا).",
        calculation: "يوضع كل قيد في يوم تاريخ تسجيله.",
        period: ENTRY_DATE.ar,
        filters: COMMISSION_FILTER.ar,
        example: `يوم 12: 2 من عمليات التسليم بـ${EXAMPLE_COMMISSION.ratePerOrder} MAD ← 20 MAD مستحقة في ذلك اليوم.`,
      }
    ),
  },
  commissionByAgent: {
    labels: ["Par agent"],
    sections: ["commissions"],
    source: "src/lib/analytics/queries/commissions.ts — getCommissionAnalytics (byAgent)",
    access: COMMISSIONS,
    text: bi(
      {
        definition: "Gagnées, annulées et nettes par agent de confirmation.",
        calculation: "Par agent : somme de ses écritures gagnées (nombre entre parenthèses), annulées, et nettes = gagnées − annulées.",
        period: ENTRY_DATE.fr,
        filters: COMMISSION_FILTER.fr,
        example: `${EXAMPLE_COMMISSION.agent} : ${mad(commissionEarned)} (${EXAMPLE_COMMISSION.earnedEntries}), ${mad(commissionReversed)} (${EXAMPLE_COMMISSION.reversedEntries}), net ${mad(commissionEarned - commissionReversed)}.`,
        caveats: "Un agent désactivé garde ses écritures (badge « inactif »).",
      },
      {
        definition: "المستحقة والملغاة والصافية لكل وكيل تأكيد.",
        calculation: "لكل وكيل: مجموع قيوده المستحقة (العدد بين قوسين)، والملغاة، والصافية = المستحقة − الملغاة.",
        period: ENTRY_DATE.ar,
        filters: COMMISSION_FILTER.ar,
        example: `${EXAMPLE_COMMISSION.agent}: ${mad(commissionEarned)} (${EXAMPLE_COMMISSION.earnedEntries})، ${mad(commissionReversed)} (${EXAMPLE_COMMISSION.reversedEntries})، الصافي ${mad(commissionEarned - commissionReversed)}.`,
        caveats: "الوكيل المعطَّل يحتفظ بقيوده (شارة « inactif »).",
      }
    ),
  },
} satisfies Record<string, AnalyticsMetricDoc>;

export type AnalyticsMetricId = keyof typeof ANALYTICS_METRICS;

export const ANALYTICS_METRIC_IDS = Object.keys(ANALYTICS_METRICS) as AnalyticsMetricId[];

export function metricsForSection(section: AnalyticsSection): AnalyticsMetricId[] {
  return ANALYTICS_METRIC_IDS.filter((id) => (ANALYTICS_METRICS[id].sections as readonly AnalyticsSection[]).includes(section));
}

/** UI strings of the explanation chrome itself (they change with the explanation language too). */
export const EXPLANATION_UI = {
  howComputed: { fr: (label: string) => `Comment est calculé « ${label} » ?`, ar: (label: string) => `كيف يُحسب « ${label} »؟` },
  fullDetails: { fr: "Détails complets : « Définitions des indicateurs » en bas de page", ar: "التفاصيل الكاملة: « Définitions des indicateurs » أسفل الصفحة" },
  access: { fr: "Accès", ar: "الصلاحية" },
  source: { fr: "Source", ar: "المصدر" },
  toggleLabel: "Langue des explications",
} as const;
