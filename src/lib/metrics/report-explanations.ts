import { bi, type ExplanationDoc } from "@/lib/metrics/analytics-explanations";
import { EXAMPLE, EXAMPLE_DURATIONS, EXAMPLE_ORDERS, EXAMPLE_STORE, orderTotal } from "@/lib/metrics/example-dataset";

/**
 * Explanations of EVERY figure shown by the /rapports pages — the registry
 * behind their « ⓘ » popovers and « Définitions des indicateurs » panels.
 * Same contract as src/lib/metrics/analytics-explanations.ts: explanation
 * text only (never read by a query, an export or a permission check), each
 * entry describing what the code ACTUALLY computes (`source`), French and
 * Arabic carrying the same sections (`bi`). Worked examples reuse the
 * fictional « Boutique Exemple » (src/lib/metrics/example-dataset.ts) where
 * the report's formula is the same; otherwise small fictional numbers.
 * Pure and client-safe.
 */

export type ReportId =
  | "ventes"
  | "canaux"
  | "livraison"
  | "tresorerie"
  | "stock"
  | "clients"
  | "retours"
  | "rentabilite"
  | "profitabilite"
  | "profitabilite-produit"
  | "profitabilite-campagne";

export interface ReportMetricDoc extends ExplanationDoc {
  /** Report pages that display it. */
  reports: readonly ReportId[];
}

// ---------------------------------------------------------------------------
// Number formatting (identical in both languages: Western digits, MAD)
// ---------------------------------------------------------------------------

const nf = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/ /g, " ");
const mad = (n: number) => `${nf(n)} MAD`;
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1).replace(".", ",")} %`);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const E = EXAMPLE;

// Rentabilité / profitabilité on the dataset (same lines as /analyses › Produits).
const productRevenue = E.productRevenue; // 1 345
const cogs = E.finance.cogs; // 620
const grossMargin = r2(productRevenue - cogs); // 725
const grossMarginPct = r1((grossMargin / productRevenue) * 100); // 53,9
const deliveryCost = E.finance.deliveryCost; // 180 — shipments of the window's orders, cancelled excluded
const profit = r2(productRevenue - cogs - deliveryCost); // 545
const profitPct = r1((profit / productRevenue) * 100); // 40,5
const sac = E.products.find((p) => p.product === "Sac Atlas")!;
// Sac Atlas' share of delivery: CMD-101 (all of 35), CMD-103 (135/330 of 35), CMD-105 (all of 20, failed: cost, no revenue).
const cmd103 = EXAMPLE_ORDERS.find((o) => o.ref === "CMD-103")!;
const cmd103Lines = cmd103.lines.reduce((n, l) => n + l.qty * l.unitPrice, 0);
const sacShare103 = r2((35 * 135) / cmd103Lines);
const sacDelivery = r2(35 + sacShare103 + 20);
const sacProfit = r2(sac.revenue - sac.cost - sacDelivery);
const sacProfitPct = r1((sacProfit / sac.revenue) * 100);

// Delivery report on the dataset's six parcels (all created in the window).
const shippedHours = EXAMPLE_DURATIONS.shippedToDelivered;
const avgDays = r1(shippedHours.reduce((a, b) => a + b, 0) / shippedHours.length / 24);
const codPaid = orderTotal(EXAMPLE_ORDERS[0]) + orderTotal(EXAMPLE_ORDERS[1]); // CMD-101, 102 delivered + paid
const codPending = orderTotal(EXAMPLE_ORDERS[2]) + orderTotal(EXAMPLE_ORDERS[3]); // CMD-103 delivered, CMD-104 in transit, unpaid

// In-store figures.
const storeGross = EXAMPLE_STORE.sales.reduce((a, b) => a + b, 0);
const storeNet = storeGross - EXAMPLE_STORE.refundsReceived;

// ---------------------------------------------------------------------------
// Shared snippets
// ---------------------------------------------------------------------------

const ANALYTICS = "analytics.view + un canal En ligne";
const FINANCE = "analytics.view + finance.view + un canal En ligne";
const PERIOD = {
  fr: "Période choisie en haut de page (mois en cours par défaut, ou trimestre, année, dates personnalisées), premier et dernier jour inclus, jours découpés dans le fuseau horaire de la boutique.",
  ar: "الفترة المختارة أعلى الصفحة (الشهر الحالي افتراضيًا، أو الربع أو السنة أو تواريخ مخصّصة)، مع احتساب اليوم الأول والأخير، وتُحدَّد الأيام حسب المنطقة الزمنية للمتجر.",
};
const PLACED = {
  fr: `Date de la commande (placedAt). ${PERIOD.fr}`,
  ar: `تاريخ الطلب (placedAt). ${PERIOD.ar}`,
};
const VALID = {
  fr: "Commandes passées sur la période, sauf celles au statut Annulée, Échec, Retour ou Remboursée.",
  ar: "الطلبات المسجَّلة خلال الفترة باستثناء الطلبات بحالة Annulée أو Échec أو Retour أو Remboursée.",
};
const CREATED = {
  fr: `Date de création de l'expédition (createdAt). ${PERIOD.fr}`,
  ar: `تاريخ إنشاء الشحنة (createdAt). ${PERIOD.ar}`,
};
const RECEIVED = {
  fr: `Date de réception du retour (receivedAt). ${PERIOD.fr}`,
  ar: `تاريخ استلام الإرجاع (receivedAt). ${PERIOD.ar}`,
};
const OUTCOME = {
  fr: "Une seule fois par commande, d'après sa dernière expédition réelle (les tentatives remplacées et les créations API refusées sont ignorées) ; « Retour » / « Remboursée » sur la commande l'emporte.",
  ar: "مرة واحدة لكل طلب، حسب آخر شحنة فعلية له (تُهمَل المحاولات المستبدَلة وعمليات الإنشاء عبر API المرفوضة)؛ وتتقدّم حالة « Retour » / « Remboursée » على الطلب.",
};
const NO_REFUND = {
  fr: "Les remboursements ne sont pas déduits ici (ils sont enregistrés par commande, pas par ligne), ni les dépenses.",
  ar: "لا تُخصم الاستردادات هنا (فهي مسجّلة لكل طلب وليس لكل سطر)، ولا المصاريف.",
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const REPORT_METRICS = {
  // ------------------------------------------------------------ Ventes
  salesRevenue: {
    labels: ["Chiffre d'affaires"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — kpiFrom (netRevenue)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Ce que la boutique a vendu en ligne sur la période, remboursements déduits — la même définition que le tableau de bord, Finance et Analyses.",
        calculation: "Somme des totaux des commandes valides (livraison facturée comprise, remises déduites) − remboursements « Complété » de ces commandes. Sous le chiffre : la même valeur sur la période précédente ; la courbe : la valeur jour par jour.",
        scope: VALID.fr,
        period: `${PLACED.fr} Un remboursement compte dans la période de la commande.`,
        example: `Commandes valides CMD-101, 102, 103, 104, 107, 109, 110 = ${mad(E.grossRevenue)} ; ${mad(E.revenueRefunds)} remboursés sur CMD-103 → ${mad(E.netRevenue)}.`,
        interpretation: "Chiffre d'affaires commandé, pas l'argent encaissé (voir Trésorerie).",
      },
      {
        definition: "ما باعه المتجر إلكترونيًا خلال الفترة بعد خصم الاستردادات، بالتعريف نفسه المعتمد في لوحة القيادة والمالية والتحليلات.",
        calculation: "مجموع مبالغ الطلبات الصالحة (بما فيها رسوم التوصيل المفوترة وبعد التخفيضات) − الاستردادات « Complété » لهذه الطلبات. تحت الرقم: القيمة نفسها في الفترة السابقة؛ والمنحنى: القيمة يومًا بيوم.",
        scope: VALID.ar,
        period: `${PLACED.ar} يُحتسب الاسترداد في فترة الطلب.`,
        example: `الطلبات الصالحة CMD-101 و102 و103 و104 و107 و109 و110 = ${mad(E.grossRevenue)}؛ استرداد ${mad(E.revenueRefunds)} على CMD-103 ← ${mad(E.netRevenue)}.`,
        interpretation: "رقم المعاملات المطلوب، وليس المبلغ المحصَّل (انظر تقرير الخزينة).",
      }
    ),
  },
  salesOrders: {
    labels: ["Commandes"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — kpiFrom (ordersCount)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le nombre de commandes reçues sur la période.",
        calculation: "Toutes les commandes passées sur la période, quel que soit leur statut (annulées comprises).",
        period: PLACED.fr,
        example: `CMD-101 à CMD-110 → ${E.orders} commandes, dont ${E.cancelled} annulée.`,
      },
      {
        definition: "عدد الطلبات المستلمة خلال الفترة.",
        calculation: "جميع الطلبات المسجَّلة خلال الفترة بكل حالاتها (بما فيها الملغاة).",
        period: PLACED.ar,
        example: `من CMD-101 إلى CMD-110 ← ${E.orders} طلبات، منها ${E.cancelled} ملغى.`,
      }
    ),
  },
  salesAverageBasket: {
    labels: ["Panier moyen"],
    reports: ["ventes"],
    source: "src/lib/metrics/formulas.ts — averageBasket",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La valeur moyenne d'une commande valide.",
        calculation: "Total BRUT des commandes valides ÷ nombre de commandes valides (les remboursements ne réduisent pas le panier). « — » sans commande valide.",
        scope: VALID.fr,
        period: PLACED.fr,
        example: `${mad(E.grossRevenue)} ÷ ${E.revenueOrders} = ${mad(E.averageBasket ?? 0)}.`,
      },
      {
        definition: "متوسط قيمة الطلب الصالح.",
        calculation: "المجموع الإجمالي للطلبات الصالحة ÷ عددها (الاستردادات لا تُنقص السلة). يظهر « — » إن لم يوجد طلب صالح.",
        scope: VALID.ar,
        period: PLACED.ar,
        example: `${mad(E.grossRevenue)} ÷ ${E.revenueOrders} طلبات = ${mad(E.averageBasket ?? 0)}.`,
      }
    ),
  },
  salesUnits: {
    labels: ["Articles vendus"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — kpiFrom (unitsSold)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le nombre d'articles dans les commandes valides de la période.",
        calculation: "Somme des quantités des lignes des commandes valides.",
        scope: VALID.fr,
        period: PLACED.fr,
        example: `2 + 2 + 3 + 2 + 1 + 1 + 1 = ${E.unitsSold} articles.`,
        caveats: "Volume commandé, pas livré : les commandes pas encore confirmées comptent.",
      },
      {
        definition: "عدد القطع في الطلبات الصالحة خلال الفترة.",
        calculation: "مجموع كميات أسطر الطلبات الصالحة.",
        scope: VALID.ar,
        period: PLACED.ar,
        example: `2 + 2 + 3 + 2 + 1 + 1 + 1 = ${E.unitsSold} قطعة.`,
        caveats: "حجم مطلوب لا مسلَّم: الطلبات غير المؤكَّدة بعد تُحتسب.",
      }
    ),
  },
  salesConfirmationRate: {
    labels: ["Taux de confirmation"],
    reports: ["ventes"],
    source: "src/lib/metrics/formulas.ts — confirmationRatePct",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La part des commandes appelées qui ont été confirmées.",
        calculation: "Commandes confirmées ÷ commandes passées par la confirmation (au moins un appel enregistré, ou confirmées à l'import) × 100. Les commandes jamais appelées sont hors calcul.",
        period: PLACED.fr,
        example: `${E.confirmed} confirmées sur ${E.wentThroughConfirmation} appelées → ${pct(E.confirmationRate)}.`,
        caveats: "La flèche compare à la période précédente en % RELATIF du taux (70 % → 77 % s'affiche « +10 % »), pas en points.",
      },
      {
        definition: "نسبة الطلبات التي اتُّصل بأصحابها ثم أُكِّدت.",
        calculation: "الطلبات المؤكَّدة ÷ الطلبات التي مرّت بالتأكيد (اتصال واحد مسجَّل على الأقل، أو مؤكَّدة عند الاستيراد) × 100. الطلبات التي لم يُتّصل بها خارج الحساب.",
        period: PLACED.ar,
        example: `${E.confirmed} مؤكَّدة من ${E.wentThroughConfirmation} اتُّصل بها ← ${pct(E.confirmationRate)}.`,
        caveats: "السهم يقارن بالفترة السابقة بنسبة مئوية نسبية للمعدّل (من 70 % إلى 77 % يظهر « +10 % »)، وليس بالنقاط.",
      }
    ),
  },
  salesDeliveryRate: {
    labels: ["Taux de livraison réussie"],
    reports: ["ventes"],
    source: "src/lib/metrics/formulas.ts — deliveryOutcomeRate",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La part des commandes expédiées de la période arrivées au bout qui ont été livrées.",
        calculation: `Livrées ÷ (livrées + échecs + retournées) × 100. ${OUTCOME.fr} Colis en route : hors calcul.`,
        period: PLACED.fr,
        example: `${E.delivered} ÷ (${E.delivered} + ${E.failed} + ${E.returned}) = ${pct(E.deliveryRate)} ; CMD-104, en route, ne compte pas encore.`,
        caveats: "Flèche : variation relative du taux, pas en points.",
      },
      {
        definition: "نسبة الطلبات المشحونة خلال الفترة التي اكتمل مسارها وتمّ تسليمها.",
        calculation: `المسلَّمة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100. ${OUTCOME.ar} الطرود التي في الطريق خارج الحساب.`,
        period: PLACED.ar,
        example: `${E.delivered} ÷ (${E.delivered} + ${E.failed} + ${E.returned}) = ${pct(E.deliveryRate)}؛ والطلب CMD-104 الذي في الطريق لا يُحتسب بعد.`,
        caveats: "السهم: تغيّر نسبي في المعدّل وليس بالنقاط.",
      }
    ),
  },
  salesReturnRate: {
    labels: ["Taux de retour"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — kpiFrom (returnRate)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La part des commandes expédiées ayant une issue qui sont revenues.",
        calculation: `Retournées ÷ (livrées + échecs + retournées) × 100, à 0,1 près. ${OUTCOME.fr}`,
        period: PLACED.fr,
        example: `${E.returned} ÷ ${E.delivered + E.failed + E.returned} = ${pct(E.returnRate)}.`,
        interpretation: "Une baisse est une bonne nouvelle : la flèche est colorée en conséquence.",
        caveats: "Différent du rapport Retours, qui compte les unités physiquement reçues à leur date de réception.",
      },
      {
        definition: "نسبة الطلبات المشحونة المعروفة نتيجتها التي عادت.",
        calculation: `المُرجَعة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100، مقرَّبًا إلى 0,1. ${OUTCOME.ar}`,
        period: PLACED.ar,
        example: `${E.returned} مُرجَع ÷ ${E.delivered + E.failed + E.returned} طلبات لها نتيجة = ${pct(E.returnRate)}.`,
        interpretation: "الانخفاض خبر جيد، ولذلك يُلوَّن السهم وفقًا لذلك.",
        caveats: "يختلف عن تقرير المرتجعات الذي يحتسب القطع المستلمة فعليًا بتاريخ استلامها.",
      }
    ),
  },
  salesComparison: {
    labels: ["vs période préc."],
    reports: ["ventes"],
    source: "src/lib/reports/range.ts — deltaPct ; src/lib/reports/trend.ts — trendFromDelta",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La variation affichée sur le chiffre d'affaires et les taux, par rapport à la période précédente de même durée.",
        calculation: "(valeur − valeur précédente) ÷ |valeur précédente| × 100, à 0,1 près. Masquée si la valeur précédente est 0 ou indisponible.",
        example: "Chiffre d'affaires 1 470 MAD contre 1 200 MAD → +22,5 %.",
        caveats: "Pour un taux, c'est une variation relative (60 % → 66 % = +10 %), pas une différence de points. Aucun seuil minimal de commandes, contrairement à Analyses.",
      },
      {
        definition: "التغيّر المعروض على رقم المعاملات والنسب مقارنة بالفترة السابقة ذات المدة نفسها.",
        calculation: "(القيمة − القيمة السابقة) ÷ |القيمة السابقة| × 100، مقرَّبًا إلى 0,1. يُخفى إذا كانت القيمة السابقة 0 أو غير متوفّرة.",
        example: "رقم معاملات 1 470 MAD مقابل 1 200 MAD ← ‎+22,5 %.",
        caveats: "بالنسبة للمعدّل فهو تغيّر نسبي (من 60 % إلى 66 % = +10 %) وليس فرقًا بالنقاط. ولا يوجد حدّ أدنى لعدد الطلبات، على خلاف صفحة التحليلات.",
      }
    ),
  },
  salesSeries: {
    labels: ["Évolution par jour", "Évolution par mois"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — getSalesReport (series)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le chiffre d'affaires (barres) et le nombre de commandes (ligne), jour par jour — mois par mois au-delà de 62 jours.",
        calculation: "Chaque commande est placée au jour de sa date de commande : la ligne compte toutes les commandes, les barres leur chiffre d'affaires net (règle de la carte).",
        period: PLACED.fr,
        example: "Le 12 : 3 commandes dont 1 annulée de 140 MAD → ligne à 3, barre = total net des 2 autres.",
      },
      {
        definition: "رقم المعاملات (أعمدة) وعدد الطلبات (خط)، يومًا بيوم، وشهرًا بشهر بعد 62 يومًا.",
        calculation: "يوضع كل طلب في يوم تاريخ الطلب: الخط يعدّ كل الطلبات، والأعمدة رقم معاملاتها الصافي (قاعدة البطاقة).",
        period: PLACED.ar,
        example: "يوم 12: 3 طلبات منها 1 ملغى بقيمة 140 MAD ← الخط عند 3، والعمود = الصافي للطلبات الـ2 الأخرى.",
      }
    ),
  },
  salesByStatus: {
    labels: ["Par statut de commande"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — getSalesReport (byStatus)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les commandes de la période réparties par statut ACTUEL.",
        calculation: "Par statut : nombre de commandes et somme de leurs totaux BRUTS (remboursements non déduits), annulées et retournées comprises.",
        period: PLACED.fr,
        example: `Statut Livrée : 3 commandes, ${mad(E.deliveredRevenue)} (le remboursement de 85 MAD sur CMD-103 n'est pas déduit).`,
        caveats: "La somme de la colonne Montant n'est pas le chiffre d'affaires : elle inclut les commandes annulées, en échec ou retournées.",
      },
      {
        definition: "طلبات الفترة موزّعة حسب حالتها الحالية.",
        calculation: "لكل حالة: عدد الطلبات ومجموع مبالغها الإجمالية (دون خصم الاستردادات)، بما فيها الملغاة والمُرجَعة.",
        period: PLACED.ar,
        example: `حالة Livrée: 3 طلبات، ${mad(E.deliveredRevenue)} (لا يُخصم استرداد 85 MAD على CMD-103).`,
        caveats: "مجموع عمود المبلغ ليس رقم المعاملات: فهو يشمل الطلبات الملغاة والفاشلة والمُرجَعة.",
      }
    ),
  },
  salesByChannel: {
    labels: ["Par canal"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — getSalesReport (byChannel)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Commandes et chiffre d'affaires par origine (WooCommerce, Shopify, ou canal d'une commande manuelle).",
        calculation: "Commandes : toutes celles de l'origine. CA : chiffre d'affaires net (commandes valides − remboursements), règle de la carte.",
        period: PLACED.fr,
        example: "WhatsApp : 4 commandes dont 1 annulée de 140 MAD → 4 commandes, CA = total net des 3 autres.",
        caveats: "La colonne Commandes compte aussi les commandes annulées, alors que le CA ne les compte pas.",
      },
      {
        definition: "الطلبات ورقم المعاملات حسب المصدر (WooCommerce أو Shopify أو قناة الطلب اليدوي).",
        calculation: "الطلبات: كل طلبات المصدر. رقم المعاملات: الصافي (الطلبات الصالحة − الاستردادات) بقاعدة البطاقة.",
        period: PLACED.ar,
        example: "WhatsApp: 4 طلبات منها 1 ملغى بقيمة 140 MAD ← 4 طلبات، ورقم المعاملات = صافي الطلبات الـ3 الأخرى.",
        caveats: "عمود الطلبات يحتسب الملغاة أيضًا، أما رقم المعاملات فلا.",
      }
    ),
  },
  salesDetail: {
    labels: ["Détail chiffré"],
    reports: ["ventes"],
    source: "src/lib/queries/reports/sales.ts — getSalesReport (series)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les chiffres du graphique, ligne par ligne.",
        calculation: "Par jour (ou mois) : toutes les commandes passées ce jour-là, et leur chiffre d'affaires net.",
        period: PLACED.fr,
        example: `La somme de la colonne CA égale la carte « Chiffre d'affaires » (${mad(E.netRevenue)}) ; celle de Commandes égale ${E.orders}.`,
      },
      {
        definition: "أرقام المبيان سطرًا بسطر.",
        calculation: "لكل يوم (أو شهر): جميع الطلبات المسجَّلة في ذلك اليوم ورقم معاملاتها الصافي.",
        period: PLACED.ar,
        example: `مجموع عمود رقم المعاملات يساوي بطاقة « Chiffre d'affaires » (${mad(E.netRevenue)})، ومجموع عمود الطلبات يساوي ${E.orders}.`,
      }
    ),
  },

  // ------------------------------------------------------------ Canaux
  channelsOnline: {
    labels: ["En ligne — chiffre d'affaires"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport → computePeriodProfitability (revenue, ordersCount)",
    access: "analytics.view + un canal En ligne (capacité magasins activée)",
    text: bi(
      {
        definition: "Le chiffre d'affaires en ligne de la période — même définition que Finance et le rapport Ventes.",
        calculation: "Totaux des commandes valides − remboursements « Complété » de ces commandes. Sous le chiffre : le nombre de commandes VALIDES (annulées, échecs, retours exclus).",
        scope: VALID.fr,
        period: PLACED.fr,
        example: `${mad(E.netRevenue)}, « ${E.revenueOrders} commande(s) » — et non ${E.orders} : les 3 commandes non valides ne sont pas comptées.`,
        caveats: "Ce nombre de commandes diffère de « Commandes » du rapport Ventes, qui compte toutes les commandes. Masqué quand un magasin est sélectionné.",
      },
      {
        definition: "رقم المعاملات الإلكتروني خلال الفترة، بالتعريف نفسه المعتمد في المالية وتقرير المبيعات.",
        calculation: "مبالغ الطلبات الصالحة − الاستردادات « Complété » لهذه الطلبات. تحت الرقم: عدد الطلبات الصالحة فقط (تُستبعد الملغاة والفاشلة والمُرجَعة).",
        scope: VALID.ar,
        period: PLACED.ar,
        example: `${mad(E.netRevenue)}، « ${E.revenueOrders} commande(s) » وليس ${E.orders}: الطلبات الـ3 غير الصالحة لا تُحتسب.`,
        caveats: "هذا العدد يختلف عن « Commandes » في تقرير المبيعات الذي يحتسب كل الطلبات. يُخفى عند اختيار متجر.",
      }
    ),
  },
  channelsStoreNet: {
    labels: ["Magasin — ventes nettes"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (offline.netSales, salesCount, unitsSold)",
    access: "analytics.view + un canal Magasin (vos magasins et emplacements)",
    text: bi(
      {
        definition: "Les ventes en magasin de la période, remboursements des retours déduits.",
        calculation: "Somme des totaux des ventes en magasin − remboursements des retours reçus sur la période. Sous le chiffre : nombre de ventes et d'articles.",
        scope: "Vos magasins et emplacements uniquement ; le filtre magasin réduit encore.",
        period: "Ventes : date de vente (soldAt). Remboursements : date de réception du retour — elle peut concerner une vente plus ancienne.",
        example: `${EXAMPLE_STORE.sales.join(" + ")} = ${mad(storeGross)} − ${mad(EXAMPLE_STORE.refundsReceived)} = ${mad(storeNet)} ; ${EXAMPLE_STORE.sales.length} ventes, ${EXAMPLE_STORE.units} articles.`,
      },
      {
        definition: "مبيعات المتجر خلال الفترة بعد خصم استردادات المرتجعات.",
        calculation: "مجموع مبالغ مبيعات المتجر − استردادات المرتجعات المستلمة خلال الفترة. تحت الرقم: عدد المبيعات والقطع.",
        scope: "متاجرك ومواقعك فقط؛ ومرشّح المتجر يضيّقها أكثر.",
        period: "المبيعات: تاريخ البيع (soldAt). الاستردادات: تاريخ استلام الإرجاع، وقد يخصّ بيعًا أقدم.",
        example: `${EXAMPLE_STORE.sales.join(" + ")} = ${mad(storeGross)} − ${mad(EXAMPLE_STORE.refundsReceived)} = ${mad(storeNet)}؛ ${EXAMPLE_STORE.sales.length} مبيعات، ${EXAMPLE_STORE.units} قطع.`,
      }
    ),
  },
  channelsTotal: {
    labels: ["Total"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — combinedChannelRevenue",
    access: "un canal En ligne ET un canal Magasin",
    text: bi(
      {
        definition: "En ligne + Magasin net, sans double comptage.",
        calculation: "Chiffre d'affaires en ligne + ventes nettes magasin. Affiché seulement si vous avez accès aux deux activités.",
        example: `${mad(E.netRevenue)} + ${mad(storeNet)} = ${mad(E.netRevenue + storeNet)}.`,
        caveats: "Les deux sources ne sont pas reconnues au même moment (commande passée vs vente encaissée) : c'est une somme, pas un résultat comptable.",
      },
      {
        definition: "الإلكتروني + صافي المتجر، دون احتساب مزدوج.",
        calculation: "رقم المعاملات الإلكتروني + صافي مبيعات المتجر. لا يظهر إلا إذا كان لديك وصول إلى النشاطين معًا.",
        example: `الإلكتروني ${mad(E.netRevenue)} + المتجر ${mad(storeNet)} = المجموع ${mad(E.netRevenue + storeNet)}.`,
        caveats: "لا يُعترف بالمصدرين في اللحظة نفسها (طلب مسجَّل مقابل بيع محصَّل): هذا مجموع وليس نتيجة محاسبية.",
      }
    ),
  },
  channelsStoreDetail: {
    labels: ["Magasin — détail"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (grossSales, refunds, netSales)",
    access: "un canal Magasin",
    text: bi(
      {
        definition: "Le passage des ventes brutes aux ventes nettes du magasin.",
        calculation: "Ventes brutes (totaux des ventes de la période) − remboursements (retours reçus sur la période) = ventes nettes.",
        period: "Ventes : date de vente ; remboursements : date de réception du retour.",
        example: `${mad(storeGross)} − ${mad(EXAMPLE_STORE.refundsReceived)} = ${mad(storeNet)}.`,
      },
      {
        definition: "الانتقال من المبيعات الإجمالية إلى المبيعات الصافية للمتجر.",
        calculation: "المبيعات الإجمالية (مبالغ مبيعات الفترة) − الاستردادات (المرتجعات المستلمة خلال الفترة) = المبيعات الصافية.",
        period: "المبيعات: تاريخ البيع؛ الاستردادات: تاريخ استلام الإرجاع.",
        example: `الإجمالي ${mad(storeGross)} − الاستردادات ${mad(EXAMPLE_STORE.refundsReceived)} = الصافي ${mad(storeNet)}.`,
      }
    ),
  },
  channelsByPayment: {
    labels: ["Par mode de paiement"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (byPayment)",
    access: "un canal Magasin",
    text: bi(
      {
        definition: "Les encaissements en magasin par mode de paiement (espèces, carte…).",
        calculation: "Somme des paiements enregistrés sur les ventes de la période, par mode.",
        period: "Date de la vente.",
        example: "Une vente de 200 MAD payée 150 en espèces et 50 par carte → 150 MAD en espèces, 50 MAD par carte.",
        caveats: "Montants encaissés bruts : les remboursements ne sont pas répartis par mode.",
      },
      {
        definition: "المبالغ المحصَّلة في المتجر حسب طريقة الأداء (نقدًا، بطاقة…).",
        calculation: "مجموع الأداءات المسجّلة على مبيعات الفترة، حسب الطريقة.",
        period: "تاريخ البيع.",
        example: "بيع بقيمة 200 MAD أُدّي منها 150 نقدًا و50 بالبطاقة ← 150 MAD نقدًا و50 MAD بالبطاقة.",
        caveats: "مبالغ محصَّلة إجمالية: الاستردادات غير موزّعة على طرق الأداء.",
      }
    ),
  },
  channelsByStore: {
    labels: ["Par magasin"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (byChannel)",
    access: "un canal Magasin",
    text: bi(
      {
        definition: "Ventes et montant brut de chaque magasin.",
        calculation: "Par magasin : nombre de ventes de la période et somme de leurs totaux (avant remboursements).",
        period: "Date de la vente.",
        example: EXAMPLE_STORE.byStore.map((s) => `${s.name} : ${s.sales} vente(s), ${mad(s.gross)}`).join(" ; ") + ".",
      },
      {
        definition: "المبيعات والمبلغ الإجمالي لكل متجر.",
        calculation: "لكل متجر: عدد مبيعات الفترة ومجموع مبالغها (قبل الاستردادات).",
        period: "تاريخ البيع.",
        example: EXAMPLE_STORE.byStore.map((s) => `${s.name}: ${s.sales} عملية بيع، ${mad(s.gross)}`).join("؛ ") + ".",
      }
    ),
  },
  channelsByLocation: {
    labels: ["Par emplacement"],
    reports: ["canaux"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (byLocation)",
    access: "un canal Magasin",
    text: bi(
      {
        definition: "Ventes et montant brut par emplacement (le stock d'où la vente est sortie).",
        calculation: "Par emplacement : nombre de ventes de la période et somme de leurs totaux.",
        period: "Date de la vente.",
        example: "Un magasin servi par 2 emplacements apparaît sur 2 lignes ici et sur 1 seule dans « Par magasin ».",
      },
      {
        definition: "المبيعات والمبلغ الإجمالي حسب الموقع (المخزون الذي خرج منه البيع).",
        calculation: "لكل موقع: عدد مبيعات الفترة ومجموع مبالغها.",
        period: "تاريخ البيع.",
        example: "متجر يُزوَّد من 2 من المواقع يظهر في 2 من الأسطر هنا، وفي سطر 1 فقط في « Par magasin ».",
      }
    ),
  },

  // ------------------------------------------------------------ Livraison
  deliveryShipped: {
    labels: ["Commandes expédiées"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — getDeliveryPerformanceReport (total)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le nombre de commandes ayant une expédition créée sur la période.",
        calculation: "Une par commande : sa dernière expédition (les tentatives remplacées ne sont pas recomptées), hors créations API refusées avant d'atteindre le transporteur.",
        period: CREATED.fr,
        example: "CMD-101 à 106 ont chacune un colis créé en septembre → 6. Un colis annulé puis renvoyé chez un autre transporteur compte 1 fois.",
        caveats: "Date d'expédition CRÉÉE, pas date de commande : diffère du rapport Ventes. Une dernière expédition encore « En attente » ou « Annulée » compte aussi.",
      },
      {
        definition: "عدد الطلبات التي أُنشئت لها شحنة خلال الفترة.",
        calculation: "شحنة واحدة لكل طلب، وهي آخر شحنة له (لا تُعاد احتساب المحاولات المستبدَلة)، باستثناء عمليات الإنشاء عبر API المرفوضة قبل وصولها إلى شركة التوصيل.",
        period: CREATED.ar,
        example: "لكلّ من الطلبات CMD-101 إلى 106 طرد أُنشئ في سبتمبر ← 6. والطرد الملغى ثم المُعاد إرساله لدى شركة أخرى يُحتسب مرة 1.",
        caveats: "تاريخ إنشاء الشحنة وليس تاريخ الطلب، فيختلف عن تقرير المبيعات. وتُحتسب أيضًا آخر شحنة ما زالت « En attente » أو « Annulée ».",
      }
    ),
  },
  deliverySuccessRate: {
    labels: ["Taux de livraison réussie"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — summarise (deliveryOutcomeRate)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La part des colis arrivés au bout qui ont été livrés.",
        calculation: `Livrées ÷ (livrées + échecs + retours) × 100. ${OUTCOME.fr} Sous le chiffre : le détail livrées / échecs / retours.`,
        period: CREATED.fr,
        example: `3 livrées, 1 échec, 1 retour, 1 en transit → 3 ÷ 5 = ${pct(60)} ; « 3 livrées / 1 échecs / 1 retours ».`,
      },
      {
        definition: "نسبة الطرود التي اكتمل مسارها وتمّ تسليمها.",
        calculation: `المسلَّمة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100. ${OUTCOME.ar} تحت الرقم: تفصيل المسلَّمة / الفاشلة / المُرجَعة.`,
        period: CREATED.ar,
        example: `3 مسلَّمة و1 فاشل و1 مُرجَع و1 في الطريق ← 3 ÷ 5 = ${pct(60)}؛ « 3 livrées / 1 échecs / 1 retours ».`,
      }
    ),
  },
  deliveryAvgDays: {
    labels: ["Délai moyen de livraison"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — summarise (avgDeliveryDays)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le temps moyen entre l'expédition du colis et sa livraison.",
        calculation: "Moyenne de (date de livraison − date d'expédition du colis), en jours à 0,1 près, sur les colis livrés portant les deux dates.",
        period: CREATED.fr,
        example: `3 colis livrés en ${shippedHours.join(", ")} h → ${nf(avgDays)} j.`,
        caveats: "Un colis sans l'une des deux dates est exclu, jamais estimé.",
      },
      {
        definition: "متوسط المدة بين شحن الطرد وتسليمه.",
        calculation: "متوسط (تاريخ التسليم − تاريخ شحن الطرد) بالأيام مقرَّبًا إلى 0,1، للطرود المسلَّمة التي تحمل التاريخين.",
        period: CREATED.ar,
        example: `3 طرود سُلِّمت في ${shippedHours.join("، ")} ساعة ← ${nf(avgDays)} يوم.`,
        caveats: "الطرد الذي ينقصه أحد التاريخين يُستبعد ولا يُقدَّر.",
      }
    ),
  },
  deliveryCostTotal: {
    labels: ["Coût de livraison total"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — summarise (shippingCost, deliveryCost, returnCost, failureCost)",
    access: "analytics.view + finance.view",
    text: bi(
      {
        definition: "Ce que les colis créés sur la période ont coûté à la boutique.",
        calculation: "Somme des coûts enregistrés sur TOUTES les tentatives d'expédition (y compris remplacées), répartie en livraisons, frais de retour et frais d'échec. Hors colis annulés et commandes annulées.",
        period: CREATED.fr,
        example: "4 colis à 35 MAD + 20 MAD de retour + 20 MAD d'échec = 180 MAD (livraisons 140 · retours 20 · échecs 20).",
        caveats: "Ici rattaché à la date de création du colis ; la Finance et la Profitabilité le rattachent à la date de la commande.",
      },
      {
        definition: "ما كلّفته الطرود المُنشأة خلال الفترة للمتجر.",
        calculation: "مجموع الكلف المسجّلة على كل محاولات الشحن (بما فيها المستبدَلة)، موزّعة على التوصيل ورسوم الإرجاع ورسوم الفشل. باستثناء الطرود الملغاة والطلبات الملغاة.",
        period: CREATED.ar,
        example: "4 طرود بـ35 MAD + 20 MAD إرجاع + 20 MAD فشل = 180 MAD (التوصيل 140 · الإرجاع 20 · الفشل 20).",
        caveats: "يُنسب هنا إلى تاريخ إنشاء الطرد؛ بينما تنسبه المالية والربحية إلى تاريخ الطلب.",
      }
    ),
  },
  deliveryCodCollected: {
    labels: ["COD encaissé"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — summarise (codCollected)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La valeur des commandes livrées déjà payées.",
        calculation: "Somme des totaux des commandes dont le colis (dernière tentative) est « Livré » et dont le paiement est « Payé ».",
        period: CREATED.fr,
        example: `CMD-101 (300) et CMD-102 (250) livrées et payées → ${mad(codPaid)}.`,
        caveats: "Compte toute commande payée, quel que soit le mode de paiement (pas seulement le paiement à la livraison).",
      },
      {
        definition: "قيمة الطلبات المسلَّمة التي أُدّيت.",
        calculation: "مجموع مبالغ الطلبات التي طردها (آخر محاولة) « Livré » وحالة أدائها « Payé ».",
        period: CREATED.ar,
        example: `CMD-101 (300) وCMD-102 (250) مسلَّمان ومؤدّيان ← ${mad(codPaid)}.`,
        caveats: "يحتسب كل طلب مؤدّى أيًّا كانت طريقة الأداء (وليس فقط الأداء عند التسليم).",
      }
    ),
  },
  deliveryCodPending: {
    labels: ["COD livré mais en attente"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — summarise (codPending)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "L'argent attendu des colis livrés ou en route, pas encore encaissé.",
        calculation: "Somme des totaux des commandes dont le colis est « Livré » OU « En transit » et dont le paiement est « En attente ».",
        period: CREATED.fr,
        example: `CMD-103 (livrée, 360) + CMD-104 (en transit, 200), non payées → ${mad(codPending)}.`,
        caveats: "Malgré le libellé « livré », les colis encore en transit sont inclus. Les commandes « Partiellement payé » ne sont pas comptées.",
      },
      {
        definition: "المبالغ المنتظرة من الطرود المسلَّمة أو التي في الطريق، ولم تُحصَّل بعد.",
        calculation: "مجموع مبالغ الطلبات التي طردها « Livré » أو « En transit » وحالة أدائها « En attente ».",
        period: CREATED.ar,
        example: `CMD-103 (مسلَّم، 360) + CMD-104 (في الطريق، 200) غير مؤدّيين ← ${mad(codPending)}.`,
        caveats: "رغم كلمة « livré » في العنوان، تُدرج الطرود التي ما زالت في الطريق. ولا تُحتسب الطلبات « Partiellement payé ».",
      }
    ),
  },
  deliveryByProvider: {
    labels: ["Par transporteur"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — getDeliveryPerformanceReport (byProvider)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les mêmes indicateurs, par transporteur.",
        calculation: "Colonnes : Exp. (dernières expéditions), Livrées, Échecs, Retours, Taux livr., Délai moy. (jours), COD en attente — mêmes règles que les cartes, groupées par transporteur du colis.",
        period: CREATED.fr,
        example: "Colis échoué chez A puis renvoyé et livré chez B : la commande compte 1 fois, livrée, chez B ; le coût de A reste compté.",
      },
      {
        definition: "المؤشرات نفسها حسب شركة التوصيل.",
        calculation: "الأعمدة: Exp. (آخر الشحنات)، Livrées، Échecs، Retours، Taux livr.، Délai moy. (أيام)، COD en attente، بالقواعد نفسها المعتمدة في البطاقات، مجمّعة حسب شركة توصيل الطرد.",
        period: CREATED.ar,
        example: "طرد فشل لدى A ثم أُعيد إرساله وسُلِّم لدى B: يُحتسب الطلب مرة 1 كمسلَّم لدى B، وتبقى كلفة A محتسبة.",
      }
    ),
  },
  deliveryByCity: {
    labels: ["Par ville"],
    reports: ["livraison"],
    source: "src/lib/queries/reports/delivery.ts — getDeliveryPerformanceReport (byCity)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les mêmes indicateurs, par ville de livraison.",
        calculation: "Groupés par la ville de livraison saisie sur la commande ; « Ville inconnue » si elle est vide.",
        period: CREATED.fr,
        example: "Casablanca : 10 exp., 8 livrées, 1 échec, 1 retour → 80,0 %.",
      },
      {
        definition: "المؤشرات نفسها حسب مدينة التسليم.",
        calculation: "مجمّعة حسب مدينة التسليم المُدخلة على الطلب، و« Ville inconnue » إن كانت فارغة.",
        period: CREATED.ar,
        example: "الدار البيضاء: 10 شحنات، 8 مسلَّمة، 1 فاشل، 1 مُرجَع ← 80,0 %.",
      }
    ),
  },

  // ------------------------------------------------------------ Trésorerie
  cashCollected: {
    labels: ["Encaissé"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (collected)",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "La valeur des commandes de la période marquées « Payé ».",
        calculation: "Somme des totaux des commandes passées sur la période dont le statut de paiement est « Payé ».",
        period: PLACED.fr,
        example: "2 commandes payées de 600 et 400 MAD → 1 000 MAD encaissés.",
        caveats: "Toute commande « Payé » compte, même si elle a été annulée ou retournée ensuite ; ses remboursements sont déduits dans « Trésorerie nette ».",
      },
      {
        definition: "قيمة طلبات الفترة المعلَّمة « Payé ».",
        calculation: "مجموع مبالغ الطلبات المسجَّلة خلال الفترة التي حالة أدائها « Payé ».",
        period: PLACED.ar,
        example: "2 من الطلبات المؤدّاة بقيمة 600 و400 MAD ← 1 000 MAD محصَّلة.",
        caveats: "يُحتسب كل طلب « Payé » حتى لو أُلغي أو أُرجع لاحقًا؛ وتُخصم استرداداته في « Trésorerie nette ».",
      }
    ),
  },
  cashPending: {
    labels: ["À encaisser"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (pending, pendingPartial)",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "L'argent attendu des commandes en cours.",
        calculation: "Totaux des commandes de la période « En attente » ou « Partiellement payé », hors annulées, échecs, retours et remboursées.",
        period: PLACED.fr,
        example: "2 commandes COD en route de 200 et 400 MAD → 600 MAD à encaisser.",
        caveats: "Le montant déjà payé d'une commande partiellement payée n'est pas enregistré : elle compte pour son total entier (l'indication le précise).",
      },
      {
        definition: "المبالغ المنتظرة من الطلبات الجارية.",
        calculation: "مبالغ طلبات الفترة بحالة « En attente » أو « Partiellement payé »، باستثناء الملغاة والفاشلة والمُرجَعة والمسترَدّة.",
        period: PLACED.ar,
        example: "2 من طلبات الأداء عند التسليم في الطريق بقيمة 200 و400 MAD ← 600 MAD للتحصيل.",
        caveats: "المبلغ المؤدّى من طلب مؤدّى جزئيًا غير مسجَّل، فيُحتسب الطلب بكامل مبلغه (وتوضّح الإشارة ذلك).",
      }
    ),
  },
  cashOutflows: {
    labels: ["Sorties (dépenses + livraison)"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (outflows) ; profitability.ts — deliveryCostTotal",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "L'argent sorti : dépenses et livraison.",
        calculation: "Dépenses datées dans la période + coût de livraison des commandes passées sur la période (toutes tentatives, hors colis et commandes annulés).",
        period: "Dépenses : leur date. Livraison : date de la commande.",
        example: "200 MAD de dépenses + 180 MAD de livraison = 380 MAD.",
      },
      {
        definition: "المبالغ الخارجة: المصاريف والتوصيل.",
        calculation: "المصاريف المؤرّخة داخل الفترة + كلفة توصيل الطلبات المسجَّلة خلال الفترة (كل المحاولات، باستثناء الطرود والطلبات الملغاة).",
        period: "المصاريف: تاريخها. التوصيل: تاريخ الطلب.",
        example: "200 MAD مصاريف + 180 MAD توصيل = 380 MAD.",
      }
    ),
  },
  cashNet: {
    labels: ["Trésorerie nette"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (netCash, projectedNet)",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "Ce qui reste en caisse sur la période, et ce qu'il resterait si tout l'attendu arrivait.",
        calculation: "Encaissé − remboursements des commandes encaissées − sorties. « Projetée » = la même chose + à encaisser.",
        period: PLACED.fr,
        example: "1 000 − 100 remboursés − 380 = 520 MAD ; projetée 520 + 600 = 1 120 MAD.",
        interpretation: "Vue caisse, pas comptable : ce n'est pas le bénéfice.",
      },
      {
        definition: "ما يتبقّى في الصندوق خلال الفترة، وما سيتبقّى لو وصلت كل المبالغ المنتظرة.",
        calculation: "المحصَّل − استردادات الطلبات المحصَّلة − المبالغ الخارجة. « Projetée » = الشيء نفسه + ما يُنتظر تحصيله.",
        period: PLACED.ar,
        example: "1 000 − 100 مسترَدّة − 380 = 520 MAD؛ المتوقَّعة 520 + 600 = 1 120 MAD.",
        interpretation: "رؤية نقدية وليست محاسبية: هذا ليس هو الربح.",
      }
    ),
  },
  cashGrossMargin: {
    labels: ["Marge brute %"],
    reports: ["tresorerie"],
    source: "src/lib/profitability.ts — computePeriodProfitability (grossMarginPct)",
    access: "finance.view",
    text: bi(
      {
        definition: "La marge brute de la période, en pourcentage du chiffre d'affaires (définition de Finance).",
        calculation: "(chiffre d'affaires net − coût des marchandises) ÷ chiffre d'affaires net × 100. « — » si un coût manque ou sans chiffre d'affaires.",
        period: PLACED.fr,
        example: `(${mad(E.finance.revenue)} − ${mad(E.finance.cogs)}) ÷ ${mad(E.finance.revenue)} = ${pct(E.finance.grossMarginPct)}.`,
        caveats: "Indicateur comptable (à la commande), affiché ici pour contexte.",
      },
      {
        definition: "الهامش الإجمالي للفترة كنسبة من رقم المعاملات (تعريف المالية).",
        calculation: "(رقم المعاملات الصافي − كلفة البضاعة) ÷ رقم المعاملات الصافي × 100. يظهر « — » إذا نقصت كلفة أو انعدم رقم المعاملات.",
        period: PLACED.ar,
        example: `الهامش: (${mad(E.finance.revenue)} − ${mad(E.finance.cogs)}) ÷ ${mad(E.finance.revenue)} = ${pct(E.finance.grossMarginPct)}.`,
        caveats: "مؤشر محاسبي (عند الطلب)، معروض هنا للسياق.",
      }
    ),
  },
  cashRefunded: {
    labels: ["Remboursé"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (refunded)",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "L'argent rendu aux clients pour les commandes de la période.",
        calculation: "Somme des remboursements « Complété » de toutes les commandes passées sur la période, quel que soit leur statut.",
        period: `${PLACED.fr} C'est la date de la commande qui compte, pas celle du remboursement.`,
        example: `85 MAD sur CMD-103 + 330 MAD sur CMD-106 = ${mad(E.refunded)}.`,
      },
      {
        definition: "المبالغ المُعادة للزبائن عن طلبات الفترة.",
        calculation: "مجموع الاستردادات « Complété » لكل الطلبات المسجَّلة خلال الفترة مهما كانت حالتها.",
        period: `${PLACED.ar} العبرة بتاريخ الطلب لا بتاريخ الاسترداد.`,
        example: `85 MAD على CMD-103 + 330 MAD على CMD-106 = ${mad(E.refunded)}.`,
      }
    ),
  },
  cashByMethod: {
    labels: ["Encaissements par mode de paiement"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (byMethod)",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "Encaissé et à encaisser, par mode de paiement de la commande.",
        calculation: "Mêmes règles que les cartes « Encaissé » et « À encaisser », regroupées par mode (paiement à la livraison, virement, carte…).",
        period: PLACED.fr,
        example: "Paiement à la livraison : 700 MAD encaissés, 600 MAD à encaisser.",
      },
      {
        definition: "المحصَّل وما يُنتظر تحصيله حسب طريقة أداء الطلب.",
        calculation: "القواعد نفسها المعتمدة في بطاقتي « Encaissé » و« À encaisser »، مجمّعة حسب الطريقة (الأداء عند التسليم، التحويل، البطاقة…).",
        period: PLACED.ar,
        example: "الأداء عند التسليم: 700 MAD محصَّلة و600 MAD للتحصيل.",
      }
    ),
  },
  cashOutflowsByCategory: {
    labels: ["Sorties par poste"],
    reports: ["tresorerie"],
    source: "src/lib/queries/reports/cashflow.ts — getCashflowReport (expensesByCategory, deliveryCost)",
    access: "finance.view + un canal En ligne",
    text: bi(
      {
        definition: "Le détail des sorties : chaque catégorie de dépense, puis la livraison.",
        calculation: "Dépenses de la période par catégorie + frais de livraison = total des sorties.",
        period: "Dépenses : leur date. Livraison : date de la commande.",
        example: "Publicité 200 MAD + frais de livraison 180 MAD = total 380 MAD.",
      },
      {
        definition: "تفصيل المبالغ الخارجة: كل فئة مصاريف ثم التوصيل.",
        calculation: "مصاريف الفترة حسب الفئة + رسوم التوصيل = مجموع المبالغ الخارجة.",
        period: "المصاريف: تاريخها. التوصيل: تاريخ الطلب.",
        example: "الإشهار 200 MAD + رسوم التوصيل 180 MAD = المجموع 380 MAD.",
      }
    ),
  },

  // ------------------------------------------------------------ Stock
  stockValueAtCost: {
    labels: ["Valeur au coût"],
    reports: ["stock"],
    source: "src/lib/queries/reports/stock-valuation.ts — getStockValuationReport (valueAtCost)",
    access: "analytics.view + finance.view (sinon carte absente)",
    text: bi(
      {
        definition: "Ce que le stock actuel a coûté à l'achat.",
        calculation: "Σ quantité en stock × coût d'achat actuel (coût de l'emplacement, sinon de la variation, sinon du produit). Une ligne sans coût compte 0 et est signalée « N article(s) sans coût ».",
        scope: "Stock actuel (quantité > 0) des emplacements que vous pouvez voir, ou de l'emplacement choisi.",
        period: "Aucune : photo du stock à l'instant.",
        example: "Sac Atlas 10 × 60 MAD = 600 MAD ; Foulard Rif 4 unités sans coût → 600 MAD, « 1 article(s) sans coût ».",
        caveats: "Coût ACTUEL, pas le coût figé à la vente utilisé par les rapports de marge.",
      },
      {
        definition: "ما كلّفه المخزون الحالي عند الشراء.",
        calculation: "Σ الكمية في المخزون × كلفة الشراء الحالية (كلفة الموقع، وإلا كلفة المتغيّر، وإلا كلفة المنتج). السطر بلا كلفة يُحتسب 0 ويُشار إليه « N article(s) sans coût ».",
        scope: "المخزون الحالي (الكمية > 0) في المواقع التي يمكنك رؤيتها، أو الموقع المختار.",
        period: "لا شيء: صورة المخزون في اللحظة الحالية.",
        example: "Sac Atlas: 10 × 60 MAD = 600 MAD؛ Foulard Rif: 4 قطع بلا كلفة ← 600 MAD، و« 1 article(s) sans coût ».",
        caveats: "الكلفة الحالية، وليست الكلفة المثبّتة عند البيع التي تعتمدها تقارير الهامش.",
      }
    ),
  },
  stockValueAtRetail: {
    labels: ["Valeur au prix de vente"],
    reports: ["stock"],
    source: "src/lib/queries/reports/stock-valuation.ts — getStockValuationReport (valueAtRetail)",
    access: "analytics.view",
    text: bi(
      {
        definition: "Ce que vaudrait le stock actuel vendu au prix catalogue.",
        calculation: "Σ quantité × prix de vente (prix de la variation, sinon prix promo du produit, sinon prix du produit).",
        period: "Aucune : stock actuel.",
        example: "Sac Atlas 10 × 135 = 1 350 MAD + Foulard Rif 4 × 110 = 440 MAD → 1 790 MAD.",
      },
      {
        definition: "قيمة المخزون الحالي لو بيع بسعر الكتالوج.",
        calculation: "Σ الكمية × سعر البيع (سعر المتغيّر، وإلا السعر الترويجي للمنتج، وإلا سعر المنتج).",
        period: "لا شيء: المخزون الحالي.",
        example: "القيمة: Sac Atlas: 10 × 135 = 1 350 MAD + Foulard Rif: 4 × 110 = 440 MAD ← 1 790 MAD.",
      }
    ),
  },
  stockPotentialMargin: {
    labels: ["Marge potentielle"],
    reports: ["stock"],
    source: "src/lib/queries/reports/stock-valuation.ts — getStockValuationReport (potentialMargin)",
    access: "analytics.view + finance.view",
    text: bi(
      {
        definition: "L'écart entre la valeur au prix de vente et la valeur au coût.",
        calculation: "Valeur au prix de vente − valeur au coût.",
        period: "Aucune : stock actuel.",
        example: "1 790 − 600 = 1 190 MAD.",
        caveats: "Les articles sans coût sont dans la valeur au prix de vente mais pas dans la valeur au coût : la marge est alors surestimée (ici de 440 MAD, le Foulard Rif).",
      },
      {
        definition: "الفرق بين قيمة المخزون بسعر البيع وقيمته بالكلفة.",
        calculation: "القيمة بسعر البيع − القيمة بالكلفة.",
        period: "لا شيء: المخزون الحالي.",
        example: "بسعر البيع 1 790 − بالكلفة 600 = 1 190 MAD.",
        caveats: "القطع بلا كلفة تدخل في القيمة بسعر البيع لا في القيمة بالكلفة، فيكون الهامش مضخَّمًا (هنا بـ440 MAD، أي Foulard Rif).",
      }
    ),
  },
  stockSkuCount: {
    labels: ["Références en stock"],
    reports: ["stock"],
    source: "src/lib/queries/reports/stock-valuation.ts — getStockValuationReport (skuCount, unitsOnHand)",
    access: "analytics.view",
    text: bi(
      {
        definition: "Le nombre de lignes de stock non vides, et le nombre d'unités.",
        calculation: "Nombre de lignes (un article dans un emplacement) avec une quantité > 0. Sous le chiffre : la somme des quantités.",
        period: "Aucune : stock actuel.",
        example: "Sac Atlas dans 2 emplacements + Foulard Rif dans 1 → 3 références, 14 unités si 6 + 4 + 4.",
        caveats: "Un même article présent dans 2 emplacements compte 2 fois.",
      },
      {
        definition: "عدد أسطر المخزون غير الفارغة وعدد القطع.",
        calculation: "عدد الأسطر (قطعة في موقع) ذات كمية > 0. تحت الرقم: مجموع الكميات.",
        period: "لا شيء: المخزون الحالي.",
        example: "Sac Atlas في 2 من المواقع + Foulard Rif في موقع 1 ← 3 مراجع، و14 قطعة إذا كانت 6 + 4 + 4.",
        caveats: "القطعة نفسها الموجودة في 2 من المواقع تُحتسب مرتين.",
      }
    ),
  },
  stockDormant: {
    labels: ["Articles dormants (60 j)"],
    reports: ["stock"],
    source: "src/lib/queries/reports/stock-valuation.ts — getStockValuationReport (dormantSkuCount, dormantValueAtCost)",
    access: "analytics.view (valeur immobilisée : finance.view)",
    text: bi(
      {
        definition: "Les lignes de stock d'articles qui ne se sont pas vendus depuis 60 jours.",
        calculation: "Lignes en stock dont l'article a vendu 0 unité ces 60 derniers jours (commandes en ligne valides si vous avez un canal En ligne, ventes de vos magasins si vous avez un canal Magasin). Sous le chiffre : leur valeur au coût « immobilisée ».",
        period: "Les 60 jours précédant aujourd'hui (date de commande / de vente).",
        example: "Foulard Rif : 4 en stock, aucune vente depuis 60 jours → 1 article dormant.",
        caveats: "Les ventes sont comptées tous emplacements confondus : un article vendu ailleurs n'est dormant dans aucun emplacement.",
      },
      {
        definition: "أسطر مخزون القطع التي لم تُبع منذ 60 يومًا.",
        calculation: "أسطر المخزون التي باعت قطعتها 0 وحدة خلال آخر 60 يومًا (الطلبات الإلكترونية الصالحة إن كانت لديك قناة إلكترونية، ومبيعات متاجرك إن كانت لديك قناة متجر). تحت الرقم: قيمتها بالكلفة « المجمّدة ».",
        period: "الأيام الـ60 السابقة لليوم (تاريخ الطلب / البيع).",
        example: "Foulard Rif: 4 في المخزون ولا بيع منذ 60 يومًا ← 1 قطعة راكدة.",
        caveats: "تُحتسب المبيعات في كل المواقع معًا: القطعة المبيعة في موقع آخر لا تُعدّ راكدة في أي موقع.",
      }
    ),
  },
  stockDetail: {
    labels: ["Détail par article"],
    reports: ["stock"],
    source: "src/lib/queries/reports/stock-valuation.ts — getStockValuationReport (rows)",
    access: "analytics.view (valeur au coût : finance.view)",
    text: bi(
      {
        definition: "Chaque ligne de stock : emplacement, article, quantité, valeurs et ventes récentes.",
        calculation: "Qté = quantité en stock ; Valeur au coût = Qté × coût actuel ; Valeur au PV = Qté × prix de vente ; Ventes 60 j = unités vendues sur 60 jours (tous emplacements). Les lignes surlignées sont dormantes.",
        period: "Stock actuel ; ventes des 60 derniers jours.",
        example: "Sac Atlas, Entrepôt principal : 6 unités, 360 MAD au coût, 810 MAD au PV, 5 ventes.",
      },
      {
        definition: "كل سطر مخزون: الموقع والقطعة والكمية والقيم والمبيعات الأخيرة.",
        calculation: "Qté = الكمية في المخزون؛ Valeur au coût = Qté × الكلفة الحالية؛ Valeur au PV = Qté × سعر البيع؛ Ventes 60 j = القطع المبيعة خلال 60 يومًا (كل المواقع). الأسطر الملوّنة راكدة.",
        period: "المخزون الحالي؛ ومبيعات آخر 60 يومًا.",
        example: "Sac Atlas في المستودع الرئيسي: 6 قطع، 360 MAD بالكلفة، 810 MAD بسعر البيع، و5 مبيعات.",
      }
    ),
  },

  // ------------------------------------------------------------ Clients
  customersBuyers: {
    labels: ["Clients acheteurs"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (distinctBuyers)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le nombre de clients différents ayant passé une commande valide sur la période.",
        calculation: "Clients distincts parmi les commandes valides de la période.",
        scope: VALID.fr,
        period: PLACED.fr,
        example: "7 commandes valides passées par 5 clients → 5 clients acheteurs.",
      },
      {
        definition: "عدد الزبائن المختلفين الذين سجّلوا طلبًا صالحًا خلال الفترة.",
        calculation: "الزبائن المتميّزون بين الطلبات الصالحة للفترة.",
        scope: VALID.ar,
        period: PLACED.ar,
        example: "7 طلبات صالحة من 5 زبائن ← 5 زبائن مشترين.",
      }
    ),
  },
  customersNew: {
    labels: ["Nouveaux clients"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (newCustomers, revenueFromNew)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les acheteurs de la période dont la toute première commande tombe dans la période.",
        calculation: "Acheteurs dont la première commande de tout l'historique (tous statuts) est dans la période. Sous le chiffre : total BRUT de leurs commandes valides de la période.",
        period: PLACED.fr,
        example: "3 des 5 acheteurs commandent pour la 1re fois → 3 nouveaux, 820 MAD de CA.",
        caveats: "Le CA indiqué est brut (remboursements non déduits), contrairement au « Chiffre d'affaires ».",
      },
      {
        definition: "مشترو الفترة الذين يقع أول طلب لهم على الإطلاق داخل الفترة.",
        calculation: "المشترون الذين يقع أول طلب لهم في كامل السجل (بكل الحالات) داخل الفترة. تحت الرقم: المجموع الإجمالي لطلباتهم الصالحة خلال الفترة.",
        period: PLACED.ar,
        example: "3 من أصل 5 مشترين يطلبون للمرة 1 ← 3 زبائن جدد، و820 MAD رقم معاملات.",
        caveats: "رقم المعاملات المذكور إجمالي (دون خصم الاستردادات)، على خلاف « Chiffre d'affaires ».",
      }
    ),
  },
  customersReturning: {
    labels: ["Clients récurrents"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (returningCustomers, revenueFromReturning)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les acheteurs de la période qui avaient déjà commandé avant.",
        calculation: "Acheteurs − nouveaux clients. Sous le chiffre : total brut de leurs commandes valides de la période.",
        period: PLACED.fr,
        example: "5 − 3 = 2 récurrents, 735 MAD de CA.",
      },
      {
        definition: "مشترو الفترة الذين سبق لهم الطلب من قبل.",
        calculation: "المشترون − الزبائن الجدد. تحت الرقم: المجموع الإجمالي لطلباتهم الصالحة خلال الفترة.",
        period: PLACED.ar,
        example: "5 − 3 = 2 زبونان متكرّران، و735 MAD رقم معاملات.",
      }
    ),
  },
  customersRepeatRate: {
    labels: ["Taux de réachat"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (repeatRatePct)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "La part des acheteurs de la période qui étaient déjà clients.",
        calculation: "Clients récurrents ÷ clients acheteurs × 100, à 0,1 près. « — » sans acheteur.",
        period: PLACED.fr,
        example: "2 ÷ 5 = 40,0 %.",
      },
      {
        definition: "نسبة مشتري الفترة الذين كانوا زبائن من قبل.",
        calculation: "الزبائن المتكرّرون ÷ الزبائن المشترون × 100، مقرَّبًا إلى 0,1. يظهر « — » إن لم يوجد مشترٍ.",
        period: PLACED.ar,
        example: "2 متكرّران ÷ 5 مشترين = 40,0 %.",
      }
    ),
  },
  customersOrdersPerBuyer: {
    labels: ["Commandes / client"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (avgOrdersPerBuyer)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Le nombre moyen de commandes valides par acheteur sur la période.",
        calculation: "Commandes valides ÷ clients acheteurs, à 0,1 près.",
        period: PLACED.fr,
        example: "7 ÷ 5 = 1,4.",
      },
      {
        definition: "متوسط عدد الطلبات الصالحة لكل مشترٍ خلال الفترة.",
        calculation: "الطلبات الصالحة ÷ الزبائن المشترون، مقرَّبًا إلى 0,1.",
        period: PLACED.ar,
        example: "7 طلبات ÷ 5 مشترين = 1,4.",
      }
    ),
  },
  customersRevenuePerBuyer: {
    labels: ["CA / client"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (avgRevenuePerBuyer)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Ce qu'un acheteur a commandé en moyenne sur la période.",
        calculation: "Total BRUT des commandes valides ÷ clients acheteurs (remboursements non déduits).",
        period: PLACED.fr,
        example: "1 555 MAD ÷ 5 = 311 MAD.",
      },
      {
        definition: "متوسط ما طلبه المشتري الواحد خلال الفترة.",
        calculation: "المجموع الإجمالي للطلبات الصالحة ÷ الزبائن المشترون (دون خصم الاستردادات).",
        period: PLACED.ar,
        example: "1 555 MAD ÷ 5 مشترين = 311 MAD.",
      }
    ),
  },
  customersTop: {
    labels: ["Meilleurs clients"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (topCustomers)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Les 50 clients qui ont le plus commandé sur la période.",
        calculation: "Par client : nombre de commandes valides (Cmd) et leur total brut (CA), triés par CA. « nouveau » = première commande dans la période. Ville = ville de la fiche client.",
        period: PLACED.fr,
        example: "Sara : 2 commandes, 465 MAD, « nouveau ».",
      },
      {
        definition: "الزبائن الخمسون الأكثر طلبًا خلال الفترة.",
        calculation: "لكل زبون: عدد الطلبات الصالحة (Cmd) ومجموعها الإجمالي (CA)، مرتّبين حسب رقم المعاملات. « nouveau » = أول طلب داخل الفترة. المدينة = مدينة بطاقة الزبون.",
        period: PLACED.ar,
        example: "سارة: 2 طلبات، 465 MAD، « nouveau ».",
      }
    ),
  },
  customersByCity: {
    labels: ["Par ville"],
    reports: ["clients"],
    source: "src/lib/queries/reports/customers.ts — getCustomerReport (byCity)",
    access: ANALYTICS,
    text: bi(
      {
        definition: "Acheteurs, commandes et CA brut par ville du client.",
        calculation: "Groupés par la ville de la fiche client (pas l'adresse de livraison) ; « Ville inconnue » si vide.",
        period: PLACED.fr,
        example: "Rabat : 2 acheteurs, 3 commandes, 610 MAD.",
      },
      {
        definition: "المشترون والطلبات ورقم المعاملات الإجمالي حسب مدينة الزبون.",
        calculation: "مجمّعة حسب مدينة بطاقة الزبون (وليس عنوان التسليم)، و« Ville inconnue » إن كانت فارغة.",
        period: PLACED.ar,
        example: "الرباط: 2 مشتريان، 3 طلبات، 610 MAD.",
      }
    ),
  },

  // ------------------------------------------------------------ Retours
  returnsEvents: {
    labels: ["Retours enregistrés"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — getReturnsReport / getOfflineReturnsReport (returnEvents, ordersReturned)",
    access: "analytics.view + le canal concerné (En ligne / Magasin)",
    text: bi(
      {
        definition: "Le nombre de réceptions de retour confirmées sur la période (« Confirmer le retour physique »).",
        calculation: "Nombre de retours physiques enregistrés. Sous le chiffre : nombre de commandes (en ligne) ou de ventes (magasin) distinctes concernées.",
        period: RECEIVED.fr,
        example: "CMD-106 reçue en 2 fois → 2 retours enregistrés, 1 commande concernée.",
        caveats: "Compte les marchandises réellement reçues, pas le statut « Retour » des commandes (le taux de retour du rapport Ventes est un autre indicateur).",
      },
      {
        definition: "عدد عمليات استلام المرتجعات المؤكَّدة خلال الفترة (« Confirmer le retour physique »).",
        calculation: "عدد المرتجعات الفعلية المسجّلة. تحت الرقم: عدد الطلبات (إلكترونيًا) أو المبيعات (في المتجر) المتميّزة المعنيّة.",
        period: RECEIVED.ar,
        example: "استُلم CMD-106 على 2 من الدفعات ← 2 مرتجعات مسجّلة، و1 طلب معنيّ.",
        caveats: "يحتسب البضائع المستلمة فعليًا، وليس حالة « Retour » للطلبات (نسبة الإرجاع في تقرير المبيعات مؤشر آخر).",
      }
    ),
  },
  returnsSellable: {
    labels: ["Unités revendables"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — totals.unitsSellable",
    access: "analytics.view + le canal concerné",
    text: bi(
      {
        definition: "Les unités revenues en bon état, remises en stock disponible.",
        calculation: "Somme des quantités « revendables » des retours reçus sur la période.",
        period: RECEIVED.fr,
        example: `Retour de CMD-106 : ${E.returnedUnits.sellable} Foulard Rif revendables.`,
      },
      {
        definition: "القطع التي عادت بحالة جيدة وأُعيدت إلى المخزون المتاح.",
        calculation: "مجموع الكميات « revendables » في المرتجعات المستلمة خلال الفترة.",
        period: RECEIVED.ar,
        example: `إرجاع CMD-106: ${E.returnedUnits.sellable} قطع Foulard Rif صالحة لإعادة البيع.`,
      }
    ),
  },
  returnsDamaged: {
    labels: ["Unités endommagées"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — totals.unitsDamaged",
    access: "analytics.view + le canal concerné",
    text: bi(
      {
        definition: "Les unités revenues abîmées, jamais remises en vente.",
        calculation: "Somme des quantités « endommagées » des retours reçus sur la période.",
        period: RECEIVED.fr,
        example: `Retour de CMD-106 : ${E.returnedUnits.damaged} Foulard Rif endommagé.`,
      },
      {
        definition: "القطع التي عادت تالفة ولا تُعاد إلى البيع أبدًا.",
        calculation: "مجموع الكميات « endommagées » في المرتجعات المستلمة خلال الفترة.",
        period: RECEIVED.ar,
        example: `إرجاع CMD-106: ${E.returnedUnits.damaged} قطعة Foulard Rif تالفة.`,
      }
    ),
  },
  returnsUnitsTotal: {
    labels: ["Total unités reçues"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — totals.unitsTotal",
    access: "analytics.view + un canal En ligne",
    text: bi(
      {
        definition: "Toutes les unités revenues sur la période.",
        calculation: "Revendables + endommagées.",
        period: RECEIVED.fr,
        example: `${E.returnedUnits.sellable} + ${E.returnedUnits.damaged} = ${E.returnedUnits.sellable + E.returnedUnits.damaged}.`,
      },
      {
        definition: "كل القطع التي عادت خلال الفترة.",
        calculation: "الصالحة لإعادة البيع + التالفة.",
        period: RECEIVED.ar,
        example: `${E.returnedUnits.sellable} صالحة + ${E.returnedUnits.damaged} تالفة = ${E.returnedUnits.sellable + E.returnedUnits.damaged}.`,
      }
    ),
  },
  returnsStoreRefund: {
    labels: ["Total remboursé"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — getOfflineReturnsReport (refundTotal)",
    access: "analytics.view + un canal Magasin",
    text: bi(
      {
        definition: "L'argent rendu sur les retours en magasin reçus pendant la période.",
        calculation: "Somme des montants remboursés des retours en magasin de vos magasins.",
        period: RECEIVED.fr,
        example: `Un article de ${mad(EXAMPLE_STORE.refundsReceived)} rapporté le 20 → ${mad(EXAMPLE_STORE.refundsReceived)} remboursés.`,
      },
      {
        definition: "المبالغ المُعادة عن مرتجعات المتجر المستلمة خلال الفترة.",
        calculation: "مجموع المبالغ المسترَدّة لمرتجعات متاجرك.",
        period: RECEIVED.ar,
        example: `قطعة بقيمة ${mad(EXAMPLE_STORE.refundsReceived)} أُعيدت يوم 20 ← ${mad(EXAMPLE_STORE.refundsReceived)} مسترَدّة.`,
      }
    ),
  },
  returnsByProduct: {
    labels: ["Par produit"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — byProduct",
    access: "analytics.view + le canal concerné",
    text: bi(
      {
        definition: "Les unités retournées, produit par produit.",
        calculation: "Regroupées par le SKU (sinon le nom) enregistré sur la ligne au moment de la vente : revendables, endommagées, total.",
        period: RECEIVED.fr,
        example: "Foulard Rif : 2 revendables, 1 endommagée, total 3.",
        caveats: "Un produit supprimé depuis reste listé sous son nom d'origine.",
      },
      {
        definition: "القطع المُرجَعة منتجًا بمنتج.",
        calculation: "مجمّعة حسب رمز SKU (وإلا الاسم) المسجَّل على السطر لحظة البيع: الصالحة والتالفة والمجموع.",
        period: RECEIVED.ar,
        example: "Foulard Rif: 2 صالحتان، 1 تالفة، المجموع 3.",
        caveats: "المنتج المحذوف لاحقًا يبقى مدرجًا باسمه الأصلي.",
      }
    ),
  },
  returnsByOrder: {
    labels: ["Par commande"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — getReturnsReport (byOrder)",
    access: "analytics.view + un canal En ligne",
    text: bi(
      {
        definition: "Chaque réception de retour en ligne : commande, client, qui l'a reçue, quand, et les quantités.",
        calculation: "Une ligne par réception confirmée, la plus récente d'abord. Client = nom du destinataire de la commande.",
        period: RECEIVED.fr,
        example: "CMD-106, reçu par Amine le 18 : 2 revendables, 1 endommagée.",
      },
      {
        definition: "كل عملية استلام لإرجاع إلكتروني: الطلب والزبون ومن استلمه ومتى والكميات.",
        calculation: "سطر لكل استلام مؤكَّد، الأحدث أولًا. الزبون = اسم المرسَل إليه في الطلب.",
        period: RECEIVED.ar,
        example: "CMD-106، استلمه أمين يوم 18: 2 صالحتان، 1 تالفة.",
      }
    ),
  },
  returnsBySale: {
    labels: ["Par vente"],
    reports: ["retours"],
    source: "src/lib/queries/reports/returns.ts — getOfflineReturnsReport (bySale)",
    access: "analytics.view + un canal Magasin",
    text: bi(
      {
        definition: "Chaque retour en magasin : vente, magasin, client, qui l'a reçu, quand, quantités et montant remboursé.",
        calculation: "Une ligne par retour en magasin de vos magasins, le plus récent d'abord.",
        period: RECEIVED.fr,
        example: `Vente du 28 août rapportée le 20 septembre : 1 revendable, ${mad(EXAMPLE_STORE.refundsReceived)} remboursés.`,
      },
      {
        definition: "كل إرجاع في المتجر: البيع والمتجر والزبون ومن استلمه ومتى والكميات والمبلغ المسترَدّ.",
        calculation: "سطر لكل إرجاع في متاجرك، الأحدث أولًا.",
        period: RECEIVED.ar,
        example: `بيع بتاريخ 28 غشت أُعيد يوم 20 سبتمبر: 1 صالحة، و${mad(EXAMPLE_STORE.refundsReceived)} مسترَدّة.`,
      }
    ),
  },

  // ------------------------------------------------------------ Rentabilité
  marginProductRevenue: {
    labels: ["CA produits"],
    reports: ["rentabilite"],
    source: "src/lib/queries/reports/product-profit.ts — getProductProfitReport (totals.revenue)",
    access: FINANCE,
    text: bi(
      {
        definition: "Les ventes de produits de la période, hors frais de livraison.",
        calculation: "Somme des totaux de ligne (prix × quantité, remise de ligne déduite) des commandes valides.",
        scope: VALID.fr,
        period: PLACED.fr,
        example: `${E.products.map((p) => `${p.product} ${mad(p.revenue)}`).join(" + ")} = ${mad(productRevenue)}.`,
        caveats: NO_REFUND.fr,
      },
      {
        definition: "مبيعات المنتجات خلال الفترة دون رسوم التوصيل.",
        calculation: "مجموع مبالغ الأسطر (السعر × الكمية بعد خصم تخفيض السطر) في الطلبات الصالحة.",
        scope: VALID.ar,
        period: PLACED.ar,
        example: `رقم المعاملات: ${E.products.map((p) => `${p.product} ${mad(p.revenue)}`).join(" + ")} = ${mad(productRevenue)}.`,
        caveats: NO_REFUND.ar,
      }
    ),
  },
  marginCogs: {
    labels: ["Coût des marchandises"],
    reports: ["rentabilite"],
    source: "src/lib/queries/reports/product-profit.ts — getProductProfitReport (totals.cogs)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce qu'ont coûté les articles vendus, au coût figé au moment de la vente.",
        calculation: "Σ coût figé de la ligne × quantité. « Coût manquant » si une seule ligne n'a pas de coût.",
        period: PLACED.fr,
        example: `5 × 60 + 3 × 40 + 4 × 50 = ${mad(cogs)}.`,
        caveats: "Jamais recalculé si le coût du produit change ensuite.",
      },
      {
        definition: "كلفة القطع المبيعة بالكلفة المثبّتة لحظة البيع.",
        calculation: "Σ الكلفة المثبّتة للسطر × الكمية. يظهر « Coût manquant » إذا كان سطر واحد بلا كلفة.",
        period: PLACED.ar,
        example: `الكلفة: 5 × 60 + 3 × 40 + 4 × 50 = ${mad(cogs)}.`,
        caveats: "لا يُعاد حسابها أبدًا إذا تغيّرت كلفة المنتج لاحقًا.",
      }
    ),
  },
  marginGross: {
    labels: ["Marge brute"],
    reports: ["rentabilite"],
    source: "src/lib/queries/reports/product-profit.ts — getProductProfitReport (totals.grossProfit)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce que les produits laissent après leur coût d'achat.",
        calculation: "CA produits − coût des marchandises. « Non calculable » si un coût manque.",
        period: PLACED.fr,
        example: `${mad(productRevenue)} − ${mad(cogs)} = ${mad(grossMargin)}.`,
        caveats: `${NO_REFUND.fr} Différent du « Profit » de Profitabilité, qui déduit aussi la livraison.`,
      },
      {
        definition: "ما تتركه المنتجات بعد كلفة شرائها.",
        calculation: "رقم معاملات المنتجات − كلفة البضاعة. يظهر « Non calculable » إذا نقصت كلفة.",
        period: PLACED.ar,
        example: `الهامش: ${mad(productRevenue)} − ${mad(cogs)} = ${mad(grossMargin)}.`,
        caveats: `${NO_REFUND.ar} ويختلف عن « Profit » في تقرير الربحية الذي يخصم التوصيل أيضًا.`,
      }
    ),
  },
  marginPct: {
    labels: ["Marge %"],
    reports: ["rentabilite"],
    source: "src/lib/queries/reports/product-profit.ts — marginPct",
    access: FINANCE,
    text: bi(
      {
        definition: "La marge brute en pourcentage du CA produits.",
        calculation: "Marge brute ÷ CA produits × 100, à 0,1 près. « — » si non calculable.",
        period: PLACED.fr,
        example: `${mad(grossMargin)} ÷ ${mad(productRevenue)} = ${pct(grossMarginPct)}.`,
      },
      {
        definition: "الهامش الإجمالي كنسبة من رقم معاملات المنتجات.",
        calculation: "الهامش الإجمالي ÷ رقم معاملات المنتجات × 100، مقرَّبًا إلى 0,1. يظهر « — » إذا تعذّر الحساب.",
        period: PLACED.ar,
        example: `النسبة: ${mad(grossMargin)} ÷ ${mad(productRevenue)} = ${pct(grossMarginPct)}.`,
      }
    ),
  },
  marginByCategory: {
    labels: ["Par catégorie"],
    reports: ["rentabilite"],
    source: "src/lib/queries/reports/product-profit.ts — categories",
    access: FINANCE,
    text: bi(
      {
        definition: "Unités, CA, coût, marge brute et marge % par catégorie de produit.",
        calculation: "Mêmes formules que les cartes, sur les lignes des produits de la catégorie ; « Sans catégorie » pour les autres. Une catégorie avec une ligne sans coût affiche « — » et « (N ligne(s) sans coût) ».",
        period: PLACED.fr,
        example: "Accessoires (Foulard Rif + Ceinture Fès) : 7 unités, 670 MAD, 320 MAD, 350 MAD, 52,2 %.",
      },
      {
        definition: "القطع ورقم المعاملات والكلفة والهامش الإجمالي ونسبته حسب فئة المنتج.",
        calculation: "الصيغ نفسها المعتمدة في البطاقات على أسطر منتجات الفئة، و« Sans catégorie » للبقية. الفئة التي فيها سطر بلا كلفة تعرض « — » و« (N ligne(s) sans coût) ».",
        period: PLACED.ar,
        example: "فئة Accessoires (Foulard Rif + Ceinture Fès): 7 قطع، 670 MAD، 320 MAD، 350 MAD، 52,2 %.",
      }
    ),
  },
  marginByProduct: {
    labels: ["Par produit"],
    reports: ["rentabilite"],
    source: "src/lib/queries/reports/product-profit.ts — products",
    access: FINANCE,
    text: bi(
      {
        definition: "Les mêmes colonnes, produit par produit, triées par marge brute.",
        calculation: "Par produit : Unités, CA (lignes), Coût march. (coût figé × quantité), Marge brute (CA − coût), Marge % (marge ÷ CA).",
        period: PLACED.fr,
        example: `${sac.product} : ${sac.units} unités, ${mad(sac.revenue)}, ${mad(sac.cost)}, ${mad(sac.grossProfit)}, ${pct(r1((sac.grossProfit / sac.revenue) * 100))}.`,
      },
      {
        definition: "الأعمدة نفسها منتجًا بمنتج، مرتّبة حسب الهامش الإجمالي.",
        calculation: "لكل منتج: Unités، CA (الأسطر)، Coût march. (الكلفة المثبّتة × الكمية)، Marge brute (رقم المعاملات − الكلفة)، Marge % (الهامش ÷ رقم المعاملات).",
        period: PLACED.ar,
        example: `${sac.product}: ${sac.units} قطع، ${mad(sac.revenue)}، ${mad(sac.cost)}، ${mad(sac.grossProfit)}، ${pct(r1((sac.grossProfit / sac.revenue) * 100))}.`,
      }
    ),
  },

  // ------------------------------------------------------------ Profitabilité
  profitRevenue: {
    labels: ["CA produits"],
    reports: ["profitabilite", "profitabilite-produit", "profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — getProfitabilityReport (revenue)",
    access: FINANCE,
    text: bi(
      {
        definition: "Les ventes de produits des commandes valides de la période, hors frais de livraison.",
        calculation: "Somme des totaux de ligne des commandes valides (pour un produit : ses lignes ; pour une campagne : les lignes de ses commandes).",
        scope: VALID.fr,
        period: PLACED.fr,
        example: `Toute la Boutique Exemple : ${mad(productRevenue)} ; Sac Atlas seul : ${mad(sac.revenue)}.`,
        caveats: NO_REFUND.fr,
      },
      {
        definition: "مبيعات المنتجات في الطلبات الصالحة خلال الفترة، دون رسوم التوصيل.",
        calculation: "مجموع مبالغ أسطر الطلبات الصالحة (للمنتج: أسطره؛ وللحملة: أسطر طلباتها).",
        scope: VALID.ar,
        period: PLACED.ar,
        example: `كامل Boutique Exemple: ${mad(productRevenue)}؛ وSac Atlas وحده: ${mad(sac.revenue)}.`,
        caveats: NO_REFUND.ar,
      }
    ),
  },
  profitProductCost: {
    labels: ["Coût produits"],
    reports: ["profitabilite", "profitabilite-produit", "profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — getProfitabilityReport (productCost)",
    access: FINANCE,
    text: bi(
      {
        definition: "Le coût d'achat des articles vendus, figé au moment de la vente.",
        calculation: "Σ coût figé × quantité des lignes des commandes valides. « Coût manquant » si une ligne n'a pas de coût.",
        period: PLACED.fr,
        example: `${mad(cogs)} pour la boutique ; ${mad(sac.cost)} pour Sac Atlas (5 × 60).`,
      },
      {
        definition: "كلفة شراء القطع المبيعة، مثبّتة لحظة البيع.",
        calculation: "Σ الكلفة المثبّتة × الكمية لأسطر الطلبات الصالحة. يظهر « Coût manquant » إذا كان سطر بلا كلفة.",
        period: PLACED.ar,
        example: `${mad(cogs)} للمتجر؛ و${mad(sac.cost)} لـSac Atlas (5 × 60).`,
      }
    ),
  },
  profitDeliveryCost: {
    labels: ["Frais de livraison", "Frais de livraison attribués"],
    reports: ["profitabilite", "profitabilite-produit", "profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — orderDeliveryCost + répartition par ligne",
    access: FINANCE,
    text: bi(
      {
        definition: "Le coût de livraison payé au transporteur pour les commandes de la période, attribué aux produits et aux campagnes.",
        calculation: "Coûts de toutes les expéditions des commandes de la période (y compris échecs et retours, hors colis ou commandes annulés). Pour un produit : le coût de chaque commande est réparti entre ses lignes au prorata de leur montant.",
        period: PLACED.fr,
        example: `Boutique : ${mad(deliveryCost)}. Sac Atlas : 35 (CMD-101) + 35 × 135 ÷ ${cmd103Lines} = ${nf(sacShare103)} (CMD-103) + 20 (échec CMD-105) = ${mad(sacDelivery)}.`,
        caveats: "Une commande en échec ou retournée n'apporte aucun CA mais garde son coût de livraison : c'est une vraie perte.",
      },
      {
        definition: "كلفة التوصيل المؤدّاة لشركة التوصيل عن طلبات الفترة، منسوبة إلى المنتجات والحملات.",
        calculation: "كلف كل شحنات طلبات الفترة (بما فيها الفشل والإرجاع، باستثناء الطرود أو الطلبات الملغاة). بالنسبة للمنتج: توزَّع كلفة كل طلب على أسطره بنسبة مبالغها.",
        period: PLACED.ar,
        example: `المتجر: ${mad(deliveryCost)}. Sac Atlas: 35 (CMD-101) + 35 × 135 ÷ ${cmd103Lines} = ${nf(sacShare103)} (CMD-103) + 20 (فشل CMD-105) = ${mad(sacDelivery)}.`,
        caveats: "الطلب الفاشل أو المُرجَع لا يجلب أي رقم معاملات لكنه يحتفظ بكلفة توصيله: إنها خسارة حقيقية.",
      }
    ),
  },
  profitProfit: {
    labels: ["Profit"],
    reports: ["profitabilite", "profitabilite-produit", "profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — profit",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce qui reste après le coût des produits et la livraison.",
        calculation: "CA produits − coût produits − frais de livraison. « Non calculable » si une ligne n'a pas de coût.",
        period: PLACED.fr,
        example: `${mad(productRevenue)} − ${mad(cogs)} − ${mad(deliveryCost)} = ${mad(profit)} ; Sac Atlas : ${mad(sac.revenue)} − ${mad(sac.cost)} − ${mad(sacDelivery)} = ${mad(sacProfit)}.`,
        caveats: `${NO_REFUND.fr} Ce n'est pas le bénéfice net de Finance.`,
      },
      {
        definition: "ما يتبقّى بعد كلفة المنتجات والتوصيل.",
        calculation: "رقم معاملات المنتجات − كلفة المنتجات − رسوم التوصيل. يظهر « Non calculable » إذا كان سطر بلا كلفة.",
        period: PLACED.ar,
        example: `${mad(productRevenue)} − ${mad(cogs)} − ${mad(deliveryCost)} = ${mad(profit)}؛ وSac Atlas: ${mad(sac.revenue)} − ${mad(sac.cost)} − ${mad(sacDelivery)} = ${mad(sacProfit)}.`,
        caveats: `${NO_REFUND.ar} وهذا ليس الربح الصافي في المالية.`,
      }
    ),
  },
  profitMargin: {
    labels: ["Marge", "Marge %"],
    reports: ["profitabilite", "profitabilite-produit", "profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — marginPct",
    access: FINANCE,
    text: bi(
      {
        definition: "Le profit en pourcentage du CA produits.",
        calculation: "Profit ÷ CA produits × 100, à 0,1 près. « — » si non calculable ou sans CA.",
        period: PLACED.fr,
        example: `${mad(profit)} ÷ ${mad(productRevenue)} = ${pct(profitPct)} ; Sac Atlas ${pct(sacProfitPct)}.`,
      },
      {
        definition: "الربح كنسبة من رقم معاملات المنتجات.",
        calculation: "الربح ÷ رقم معاملات المنتجات × 100، مقرَّبًا إلى 0,1. يظهر « — » إذا تعذّر الحساب أو انعدم رقم المعاملات.",
        period: PLACED.ar,
        example: `${mad(profit)} ÷ ${mad(productRevenue)} = ${pct(profitPct)}؛ وSac Atlas ${pct(sacProfitPct)}.`,
      }
    ),
  },
  profitByProduct: {
    labels: ["Par produit"],
    reports: ["profitabilite"],
    source: "src/lib/queries/reports/profitability.ts — byProduct",
    access: FINANCE,
    text: bi(
      {
        definition: "Les colonnes ci-dessus, produit par produit (cliquer ouvre le détail des commandes).",
        calculation: "Quantité vendue (commandes valides), CA, coût produits, frais de livraison attribués, profit, marge %. Trié par profit.",
        period: PLACED.fr,
        example: `Sac Atlas : ${sac.units} vendus, ${mad(sac.revenue)}, ${mad(sac.cost)}, ${mad(sacDelivery)}, ${mad(sacProfit)}, ${pct(sacProfitPct)}.`,
      },
      {
        definition: "الأعمدة أعلاه منتجًا بمنتج (النقر يفتح تفاصيل الطلبات).",
        calculation: "الكمية المبيعة (الطلبات الصالحة)، رقم المعاملات، كلفة المنتجات، رسوم التوصيل المنسوبة، الربح، نسبة الهامش. مرتّبة حسب الربح.",
        period: PLACED.ar,
        example: `Sac Atlas: ${sac.units} مبيعة، ${mad(sac.revenue)}، ${mad(sac.cost)}، ${mad(sacDelivery)}، ${mad(sacProfit)}، ${pct(sacProfitPct)}.`,
      }
    ),
  },
  profitByCampaign: {
    labels: ["Par campagne / source"],
    reports: ["profitabilite"],
    source: "src/lib/queries/reports/profitability.ts — byCampaign",
    access: FINANCE,
    text: bi(
      {
        definition: "Les mêmes colonnes, par campagne publicitaire attachée à la commande (« Sans campagne » sinon).",
        calculation: "Commandes (toutes celles de la campagne passées sur la période), CA et coût (commandes valides), frais de livraison (toutes ses commandes), profit, marge %.",
        period: PLACED.fr,
        example: "Campagne « Rentrée » : 10 commandes dont 1 annulée → Commandes = 10, CA et coût sur les 9 autres.",
        caveats: "La colonne Commandes inclut les commandes annulées, échouées ou retournées, alors que le CA ne les inclut pas.",
      },
      {
        definition: "الأعمدة نفسها حسب الحملة الإشهارية المرتبطة بالطلب (و« Sans campagne » إن لم توجد).",
        calculation: "الطلبات (كل طلبات الحملة المسجَّلة خلال الفترة)، رقم المعاملات والكلفة (الطلبات الصالحة)، رسوم التوصيل (كل طلباتها)، الربح، نسبة الهامش.",
        period: PLACED.ar,
        example: "حملة « Rentrée »: 10 طلبات منها 1 ملغى ← الطلبات = 10، ورقم المعاملات والكلفة على الطلبات الـ9 الأخرى.",
        caveats: "عمود الطلبات يشمل الطلبات الملغاة والفاشلة والمُرجَعة، أما رقم المعاملات فلا.",
      }
    ),
  },
  profitUnitsSold: {
    labels: ["Quantité vendue"],
    reports: ["profitabilite-produit"],
    source: "src/lib/queries/reports/profitability.ts — byProduct (unitsSold)",
    access: FINANCE,
    text: bi(
      {
        definition: "Les unités du produit vendues dans les commandes valides de la période.",
        calculation: "Somme des quantités des lignes de ce produit dans les commandes valides.",
        scope: VALID.fr,
        period: PLACED.fr,
        example: `Sac Atlas : 2 + 1 + 1 + 1 = ${sac.units} ; les 2 de CMD-105 (échec) ne comptent pas.`,
        caveats: "La colonne Qté du tableau des commandes ci-dessous, elle, inclut aussi les commandes non valides.",
      },
      {
        definition: "قطع المنتج المبيعة في الطلبات الصالحة خلال الفترة.",
        calculation: "مجموع كميات أسطر هذا المنتج في الطلبات الصالحة.",
        scope: VALID.ar,
        period: PLACED.ar,
        example: `Sac Atlas: 2 + 1 + 1 + 1 = ${sac.units}؛ والقطعتان 2 في CMD-105 (فاشل) لا تُحتسبان.`,
        caveats: "أما عمود Qté في جدول الطلبات أدناه فيشمل الطلبات غير الصالحة أيضًا.",
      }
    ),
  },
  profitCampaignOrders: {
    labels: ["Commandes"],
    reports: ["profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — byCampaign (ordersCount)",
    access: FINANCE,
    text: bi(
      {
        definition: "Le nombre de commandes de la période attribuées à cette campagne / source.",
        calculation: "Commandes distinctes de la campagne passées sur la période, tous statuts.",
        period: PLACED.fr,
        example: "10 commandes dont 1 annulée → 10.",
        caveats: "Inclut les commandes non valides, qui n'apportent ni CA ni coût produits.",
      },
      {
        definition: "عدد طلبات الفترة المنسوبة إلى هذه الحملة / المصدر.",
        calculation: "الطلبات المتميّزة للحملة المسجَّلة خلال الفترة، بكل الحالات.",
        period: PLACED.ar,
        example: "10 طلبات منها 1 ملغى ← 10.",
        caveats: "يشمل الطلبات غير الصالحة التي لا تجلب رقم معاملات ولا كلفة منتجات.",
      }
    ),
  },
  profitDetailOrders: {
    labels: ["Commandes contributrices"],
    reports: ["profitabilite-produit", "profitabilite-campagne"],
    source: "src/lib/queries/reports/profitability.ts — listOrdersForProduct / listOrdersForCampaign",
    access: FINANCE,
    text: bi(
      {
        definition: "Les commandes de la période derrière la ligne du rapport, une par une.",
        calculation: "Par commande : CA, coût produits et profit (0 si la commande n'est pas valide), frais de livraison (sa part pour un produit, tout son coût pour une campagne). Qté (produit) = quantité de la ligne, quel que soit le statut.",
        period: PLACED.fr,
        example: `CMD-105 (Échec) pour Sac Atlas : Qté 2, CA 0, coût 0, livraison 20 MAD, profit −20 MAD.`,
        caveats: "La somme des Qté peut dépasser « Quantité vendue », qui exclut les commandes non valides.",
      },
      {
        definition: "طلبات الفترة التي يتكوّن منها سطر التقرير، طلبًا بطلب.",
        calculation: "لكل طلب: رقم المعاملات وكلفة المنتجات والربح (0 إذا لم يكن الطلب صالحًا)، ورسوم التوصيل (حصّته بالنسبة للمنتج، وكامل كلفته بالنسبة للحملة). Qté (المنتج) = كمية السطر مهما كانت الحالة.",
        period: PLACED.ar,
        example: `CMD-105 (Échec) لـSac Atlas: الكمية 2، رقم المعاملات 0، الكلفة 0، التوصيل 20 MAD، الربح −20 MAD.`,
        caveats: "قد يتجاوز مجموع Qté قيمة « Quantité vendue » التي تستثني الطلبات غير الصالحة.",
      }
    ),
  },
} satisfies Record<string, ReportMetricDoc>;

export type ReportMetricId = keyof typeof REPORT_METRICS;

export const REPORT_METRIC_IDS = Object.keys(REPORT_METRICS) as ReportMetricId[];

export function metricsForReport(report: ReportId): ReportMetricId[] {
  return REPORT_METRIC_IDS.filter((id) => (REPORT_METRICS[id].reports as readonly ReportId[]).includes(report));
}
