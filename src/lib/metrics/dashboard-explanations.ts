import { ANALYTICS_METRICS, bi, type AnalyticsMetricId, type ExplanationDoc, type ExplanationLang, type MetricText } from "@/lib/metrics/analytics-explanations";
import { EXAMPLE, EXAMPLE_ATTEMPTS, EXAMPLE_COMMISSION, EXAMPLE_ORDERS, EXAMPLE_STORE } from "@/lib/metrics/example-dataset";
import { asPct, countOutcomes, deliveryOutcomeRate, orderDeliveryOutcome } from "@/lib/metrics/formulas";

/**
 * Explanations of EVERY figure shown by the dashboard (/tableau-de-bord) —
 * the registry behind its « ⓘ » popovers and its « Définitions des
 * indicateurs » panel. Same contract as src/lib/metrics/analytics-
 * explanations.ts and report-explanations.ts: explanation text only (never
 * read by a query or a permission check — the language cannot change a
 * value), each entry describing what the code ACTUALLY computes (`source`),
 * French and Arabic carrying the same sections (`bi`).
 *
 * Where a dashboard figure is the SAME concept with the same formula,
 * population and period as an /analyses figure, the entry points at that
 * figure's text object (`sharedWith`) instead of repeating it; every other
 * entry is dashboard-specific (the dashboard has its own period selector,
 * no origin / carrier / location filter, and several figures that ignore the
 * period). Worked examples reuse the fictional « Boutique Exemple »
 * (src/lib/metrics/example-dataset.ts); figures the dataset does not cover
 * use small fictional numbers, computed here. Pure and client-safe.
 */

export interface DashboardMetricDoc extends ExplanationDoc {
  /** The /analyses figure whose explanation text this entry reuses verbatim. */
  sharedWith?: AnalyticsMetricId;
}

// ---------------------------------------------------------------------------
// Number formatting (identical in both languages: Western digits, MAD)
// ---------------------------------------------------------------------------

const nf = (n: number) => n.toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).replace(/[  ]/g, " ");
const mad = (n: number) => `${nf(n)} MAD`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const E = EXAMPLE;

/** The dashboard's own trend label (src/app/(protected)/tableau-de-bord/page.tsx — trend). */
const trendLabel = (current: number, previous: number) => {
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
};

// Revenue + its comparison (the previous period is fictional).
const previousRevenue = 1200;
const revenueTrend = trendLabel(E.netRevenue, previousRevenue);

// In-store figures.
const storeGross = EXAMPLE_STORE.sales.reduce((a, b) => a + b, 0);
const storeNet = r2(storeGross - EXAMPLE_STORE.refundsReceived);
const combinedTotal = r2(E.netRevenue + storeNet);

// Charges.
const charges = r2(E.finance.expenses + E.finance.deliveryCost);

// Stock (two fictional locations).
const stockLines = [
  { location: "Casablanca", onHand: 30, reserved: 5 },
  { location: "Rabat", onHand: 12, reserved: 2 },
] as const;
const stockOnHand = stockLines.reduce((n, l) => n + l.onHand, 0);
const stockReserved = stockLines.reduce((n, l) => n + l.reserved, 0);
const stockAvailable = Math.max(0, stockOnHand - stockReserved);

// Low stock (one fictional line).
const low = { threshold: 5, onHand: 8, reserved: 4 };
const lowAvailable = low.onHand - low.reserved;

// Confirmation queue on the dataset (current status, whatever the period).
const nouvelles = EXAMPLE_ORDERS.filter((o) => o.status === "NOUVELLE");
const toRecall = nouvelles.filter((o) => o.attempts > 0);
const neverCalled = nouvelles.filter((o) => o.attempts === 0);

// Commissions.
const commissionEarned = EXAMPLE_COMMISSION.ratePerOrder * EXAMPLE_COMMISSION.earnedEntries;
const commissionReversed = EXAMPLE_COMMISSION.ratePerOrder * EXAMPLE_COMMISSION.reversedEntries;
const lifetime = { earned: 300, reversed: 30, paid: 200 };
const remaining = lifetime.earned - lifetime.reversed - lifetime.paid;

// Delivery success rate on the dataset's parcels (all created in the period).
const parcels = EXAMPLE_ORDERS.filter((o) => o.shipment !== null);
const outcomes = countOutcomes(parcels.map((o) => orderDeliveryOutcome(o.status, o.shipment)));
const finished = outcomes.delivered + outcomes.failed + outcomes.returned;
const inTransit = parcels.length - finished;
const successRate = deliveryOutcomeRate(outcomes);
const successLabel = successRate === null ? "—" : `${(successRate * 100).toFixed(1)}%`;

// Top sellers on the dataset (units of valid orders).
const ranked = [...E.products].sort((a, b) => b.units - a.units);

// ---------------------------------------------------------------------------
// Shared snippets
// ---------------------------------------------------------------------------

const BASE = "dashboard.view";
const FINANCE = `${BASE} + finance.view + un canal En ligne`;

const PERIOD = {
  fr: "Période choisie en haut de page : Aujourd'hui, Hier, Ce mois (par défaut), Ce trimestre ou Cette année — la période calendaire entière (jours à venir compris), découpée dans le fuseau horaire de la boutique. Une commande y entre par sa date de commande (placedAt).",
  ar: "الفترة المختارة أعلى الصفحة: Aujourd'hui أو Hier أو Ce mois (افتراضيًا) أو Ce trimestre أو Cette année — الفترة التقويمية كاملة (بما فيها الأيام المقبلة)، وتُحدَّد الأيام حسب المنطقة الزمنية للمتجر. يدخل الطلب فيها بتاريخ الطلب (placedAt).",
};
const TREND = {
  fr: "Flèche : écart avec la période précédente de même durée, juste avant (pour « Ce mois » en octobre, 31 jours : du 31 août au 30 septembre) = (actuel − précédent) ÷ précédent × 100, une décimale ; « stable » entre −0,5 % et +0,5 % ; pas de flèche si la période précédente vaut 0.",
  ar: "السهم: الفرق مع الفترة السابقة ذات المدة نفسها مباشرة (بالنسبة لـ« Ce mois » في أكتوبر، 31 يومًا: من 31 أغسطس إلى 30 سبتمبر) = (الحالي − السابق) ÷ السابق × 100، برقم عشري واحد؛ « ثابت » بين −0,5 % و+0,5 %؛ ولا يظهر السهم إذا كانت قيمة الفترة السابقة 0.",
};
const ONLINE_FILTER = {
  fr: "Le sélecteur Tous / En ligne / Magasin (proposé seulement si vous voyez les deux activités) affiche ou masque cette carte (« Magasin » la masque) sans jamais changer son calcul. Aucun filtre d'origine, de transporteur ou d'emplacement n'existe sur le tableau de bord.",
  ar: "محدِّد Tous / En ligne / Magasin (لا يظهر إلا إذا كنت ترى النشاطين معًا) يُظهر هذه البطاقة أو يخفيها (« Magasin » يخفيها) دون أن يغيّر حسابها أبدًا. لا يوجد في لوحة القيادة أي مرشّح للمصدر أو لشركة التوصيل أو للموقع.",
};
const STORE_FILTER = {
  fr: "Le sélecteur Tous / En ligne / Magasin affiche ou masque cette carte (« En ligne » la masque) sans changer son calcul. Pas de filtre magasin / emplacement ici : toujours l'ensemble de vos propres magasins.",
  ar: "محدِّد Tous / En ligne / Magasin يُظهر هذه البطاقة أو يخفيها (« En ligne » يخفيها) دون تغيير حسابها. لا يوجد هنا مرشّح للمتجر أو للموقع: دائمًا مجموع متاجرك المسموح لك بها.",
};
const NO_FILTER = {
  fr: "Aucun réglage du tableau de bord ne le modifie : ni la période choisie, ni le sélecteur Tous / En ligne / Magasin.",
  ar: "لا يغيّره أي إعداد في لوحة القيادة: لا الفترة المختارة ولا محدِّد Tous / En ligne / Magasin.",
};
const PERIOD_ONLY_FILTER = {
  fr: "Seule la période choisie en haut de page le modifie ; le sélecteur Tous / En ligne / Magasin ne le change pas.",
  ar: "لا تغيّره إلا الفترة المختارة أعلى الصفحة؛ ومحدِّد Tous / En ligne / Magasin لا يغيّره.",
};
/**
 * A shared /analyses text with ONLY its « Filtres » section replaced: the
 * dashboard has no Origine filter, so that line must describe the dashboard's
 * own selector. Every other section stays the /analyses text itself.
 */
function withDashboardFilters(text: Record<ExplanationLang, MetricText>, filters: { fr: string; ar: string }): Record<ExplanationLang, MetricText> {
  return { fr: { ...text.fr, filters: filters.fr }, ar: { ...text.ar, filters: filters.ar } };
}

const REVENUE_ORDERS = {
  fr: "Commandes de la période, sauf celles au statut Annulée, Échec, Retour ou Remboursée — toutes origines (WooCommerce, Shopify, commandes manuelles). Jamais les ventes en magasin.",
  ar: "طلبات الفترة باستثناء الطلبات بحالة Annulée أو Échec أو Retour أو Remboursée — من جميع المصادر (WooCommerce وShopify والطلبات اليدوية). لا تشمل أبدًا مبيعات المتجر.",
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const DASHBOARD_METRICS = {
  // ------------------------------------------------------------------ Aperçu
  totalRevenue: {
    labels: ["Chiffre d'affaires total"],
    source: "src/lib/queries/reports/channels.ts — combinedChannelRevenue (finance.revenue + offline.netSales)",
    access: `${FINANCE} + sales.view + un canal Magasin ; sélecteur sur « Tous »`,
    text: bi(
      {
        definition: "Le chiffre d'affaires en ligne et les ventes nettes des magasins, additionnés.",
        calculation: "Chiffre d'affaires en ligne (commandes valides − remboursements) + ventes magasin nettes (tickets − remboursements des retours reçus), arrondi à 0,01. Les deux chiffres sont ceux des cartes « Chiffre d'affaires en ligne » et « Ventes magasin nettes » juste en dessous.",
        scope: "N'apparaît que si vous voyez les deux activités et que le sélecteur est sur « Tous ». Les ventes magasin sont limitées à vos propres magasins.",
        period: `${PERIOD.fr} Ventes magasin : date de vente ; remboursements magasin : date de réception du retour.`,
        filters: "« En ligne » ou « Magasin » remplace ce total par le chiffre de l'activité choisie.",
        example: `En ligne ${mad(E.netRevenue)} + magasin ${mad(storeNet)} (${mad(storeGross)} − ${mad(EXAMPLE_STORE.refundsReceived)}) = ${mad(combinedTotal)}.`,
        interpretation: "Le volume d'affaires de toute la boutique sur la période. C'est une somme, pas un résultat comptable.",
        caveats: "Les deux activités ne sont pas reconnues au même moment (commande passée / vente encaissée). La courbe affichée à droite est celle du chiffre d'affaires EN LIGNE mensuel (graphique « Ventes »), pas de ce total.",
      },
      {
        definition: "رقم المعاملات الإلكتروني وصافي مبيعات المتاجر مجموعَين.",
        calculation: "رقم المعاملات الإلكتروني (الطلبات الصالحة − الاستردادات) + صافي مبيعات المتجر (التذاكر − استردادات المرتجعات المستلمة)، مقرَّبًا إلى 0,01. الرقمان هما رقما بطاقتَي « Chiffre d'affaires en ligne » و« Ventes magasin nettes » أسفله مباشرة.",
        scope: "لا يظهر إلا إذا كنت ترى النشاطين وكان المحدِّد على « Tous ». مبيعات المتجر محصورة في متاجرك المسموح لك بها.",
        period: `${PERIOD.ar} مبيعات المتجر: تاريخ البيع؛ استردادات المتجر: تاريخ استلام الإرجاع.`,
        filters: "اختيار « En ligne » أو « Magasin » يعوّض هذا المجموع برقم النشاط المختار.",
        example: `الإلكتروني ${mad(E.netRevenue)} + المتجر ${mad(storeNet)} (${mad(storeGross)} − ${mad(EXAMPLE_STORE.refundsReceived)}) = ${mad(combinedTotal)}.`,
        interpretation: "حجم أعمال المتجر بأكمله خلال الفترة. إنه مجموع وليس نتيجة محاسبية.",
        caveats: "لا يُعترف بالنشاطين في اللحظة نفسها (طلب مسجَّل مقابل بيع محصَّل). المنحنى المعروض على اليمين هو منحنى رقم المعاملات الإلكتروني الشهري (رسم « Ventes »)، وليس منحنى هذا المجموع.",
      }
    ),
  },
  revenue: {
    labels: ["Chiffre d'affaires", "Chiffre d'affaires en ligne"],
    source: "src/lib/profitability.ts — computePeriodProfitability (revenue), via getDashboardData (finance, previousFinance)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce que la boutique a vendu en ligne sur la période, remboursements déduits.",
        calculation: `Somme des totaux des commandes valides (frais de livraison facturés au client compris, remises déduites) − remboursements « Complété » enregistrés sur ces commandes. ${TREND.fr}`,
        scope: REVENUE_ORDERS.fr,
        period: `${PERIOD.fr} Un remboursement compte dans la période de la commande remboursée, même s'il a été fait plus tard.`,
        filters: ONLINE_FILTER.fr,
        example: `Commandes valides CMD-101, 102, 103, 104, 107, 109, 110 = ${mad(E.grossRevenue)} ; ${mad(E.revenueRefunds)} remboursés sur CMD-103 → ${mad(E.netRevenue)}. Période précédente (fictive) : ${mad(previousRevenue)} → flèche ${revenueTrend}.`,
        interpretation: "Le chiffre d'affaires commandé et non annulé. Ce n'est pas l'argent encaissé : une commande « Nouvelle » ou « Expédiée » est déjà comptée.",
        caveats: "« Ce mois » couvre le mois entier : en début de mois, la flèche compare quelques jours à une période complète. La courbe du bandeau est le graphique mensuel « Ventes » (année en cours ou dernière), pas la période choisie.",
      },
      {
        definition: "ما باعه المتجر إلكترونيًا خلال الفترة بعد خصم الاستردادات.",
        calculation: `مجموع مبالغ الطلبات الصالحة (بما فيها رسوم التوصيل المفوترة للزبون، وبعد خصم التخفيضات) − الاستردادات بحالة « Complété » المسجّلة على هذه الطلبات. ${TREND.ar}`,
        scope: REVENUE_ORDERS.ar,
        period: `${PERIOD.ar} يُحتسب الاسترداد في فترة الطلب المسترَدّ حتى لو تمّ لاحقًا.`,
        filters: ONLINE_FILTER.ar,
        example: `الطلبات الصالحة CMD-101 و102 و103 و104 و107 و109 و110 = ${mad(E.grossRevenue)}؛ استرداد ${mad(E.revenueRefunds)} على CMD-103 ← ${mad(E.netRevenue)}. الفترة السابقة (افتراضية): ${mad(previousRevenue)} ← السهم ${revenueTrend}.`,
        interpretation: "رقم المعاملات المطلوب وغير الملغى. ليس المبلغ المحصَّل: الطلب بحالة « Nouvelle » أو « Expédiée » يُحتسب منذ الآن.",
        caveats: "« Ce mois » يغطي الشهر كاملًا: في بداية الشهر يقارن السهم بضعة أيام بفترة كاملة. منحنى الشريط هو الرسم الشهري « Ventes » (السنة الحالية أو الماضية)، وليس الفترة المختارة.",
      }
    ),
  },
  storeNetSales: {
    labels: ["Ventes magasin nettes"],
    source: "src/lib/queries/reports/channels.ts — getChannelReport (offline: netSales, salesCount, unitsSold)",
    access: `${BASE} + sales.view + un canal Magasin (vos magasins)`,
    text: bi(
      {
        definition: "Le chiffre d'affaires des magasins (caisse) sur la période, remboursements déduits.",
        calculation: "Somme des tickets de vente − remboursements des retours reçus sur la période, arrondi à 0,01. Sous le chiffre : nombre de ventes et nombre d'articles vendus.",
        scope: "Vos magasins et emplacements uniquement. Jamais les commandes en ligne.",
        period: "Période choisie en haut de page. Ventes : date de vente (soldAt) ; remboursements : date de réception du retour.",
        filters: STORE_FILTER.fr,
        example: `${EXAMPLE_STORE.sales.length} tickets (${EXAMPLE_STORE.sales.join(", ")} MAD) = ${mad(storeGross)}, ${EXAMPLE_STORE.units} articles ; retour reçu remboursé ${mad(EXAMPLE_STORE.refundsReceived)} → ${mad(storeNet)}, « ${EXAMPLE_STORE.sales.length} vente(s) · ${EXAMPLE_STORE.units} article(s) ».`,
        interpretation: "Ce que les magasins ont réellement gardé sur la période.",
        caveats: "Mélange deux dates : une période peut porter le remboursement d'une vente plus ancienne. Le nombre de ventes et d'articles, lui, n'est pas diminué par les retours.",
      },
      {
        definition: "رقم معاملات المتاجر (الصندوق) خلال الفترة بعد خصم الاستردادات.",
        calculation: "مجموع تذاكر البيع − استردادات المرتجعات المستلمة خلال الفترة، مقرَّبًا إلى 0,01. تحت الرقم: عدد المبيعات وعدد القطع المبيعة.",
        scope: "متاجرك ومواقعك فقط. لا تشمل أبدًا الطلبات الإلكترونية.",
        period: "الفترة المختارة أعلى الصفحة. المبيعات: تاريخ البيع (soldAt)؛ الاستردادات: تاريخ استلام الإرجاع.",
        filters: STORE_FILTER.ar,
        example: `${EXAMPLE_STORE.sales.length} تذاكر (${EXAMPLE_STORE.sales.join("، ")} MAD) = ${mad(storeGross)}، و${EXAMPLE_STORE.units} قطع؛ إرجاع مستلم ومسترَدّ ${mad(EXAMPLE_STORE.refundsReceived)} ← ${mad(storeNet)}، « ${EXAMPLE_STORE.sales.length} vente(s) · ${EXAMPLE_STORE.units} article(s) ».`,
        interpretation: "ما احتفظت به المتاجر فعلًا خلال الفترة.",
        caveats: "يجمع تاريخين: قد تحمل الفترة استرداد بيع أقدم. أمّا عدد المبيعات والقطع فلا تُنقصه المرتجعات.",
      }
    ),
  },
  ordersPlaced: {
    labels: ["Commandes"],
    source: "src/lib/queries/dashboard.ts — getDashboardData (ordersPlaced)",
    access: `${BASE} + orders.view`,
    text: bi(
      {
        definition: "Le nombre de commandes en ligne reçues sur la période, quel que soit ce qu'elles sont devenues.",
        calculation: "Nombre de commandes dont la date de commande tombe dans la période — tous statuts confondus, annulées comprises.",
        scope: "Toutes les commandes en ligne (WooCommerce, Shopify, commandes manuelles). Jamais les ventes en magasin.",
        period: PERIOD.fr,
        filters: ONLINE_FILTER.fr,
        example: `Boutique Exemple : ${E.orders} commandes passées en septembre (CMD-101 à CMD-110), dont ${E.cancelled} annulée et ${E.pending} encore « Nouvelle » → ${E.orders}.`,
        interpretation: "Mesure la demande reçue — ni un nombre de ventes réalisées, ni un nombre de livraisons.",
        caveats: `Différent du nombre de commandes VALIDES qui sert au panier moyen (${E.revenueOrders} dans l'exemple).`,
      },
      {
        definition: "عدد الطلبات الإلكترونية المستلمة خلال الفترة، بغضّ النظر عمّا آلت إليه.",
        calculation: "عدد الطلبات التي يقع تاريخها داخل الفترة، بجميع الحالات بما فيها الملغاة.",
        scope: "كل الطلبات الإلكترونية (WooCommerce وShopify والطلبات اليدوية). لا تشمل أبدًا مبيعات المتجر.",
        period: PERIOD.ar,
        filters: ONLINE_FILTER.ar,
        example: `Boutique Exemple: ${E.orders} طلبات في سبتمبر (من CMD-101 إلى CMD-110)، منها ${E.cancelled} ملغى و${E.pending} ما زالا « Nouvelle » ← ${E.orders}.`,
        interpretation: "يقيس الطلب الوارد، وليس عدد المبيعات المنجزة ولا عدد عمليات التسليم.",
        caveats: `يختلف عن عدد الطلبات الصالحة المستعمل في متوسط السلة (${E.revenueOrders} في المثال).`,
      }
    ),
  },
  averageBasket: {
    labels: ["Panier moyen"],
    sharedWith: "averageBasket",
    source: "src/lib/profitability.ts — computePeriodProfitability (avgOrderValue) ; même formule que src/lib/metrics/formulas.ts — averageBasket",
    access: FINANCE,
    text: withDashboardFilters(ANALYTICS_METRICS.averageBasket.text, ONLINE_FILTER),
  },
  newCustomers: {
    labels: ["Nouveaux clients"],
    source: "src/lib/queries/dashboard.ts — countNewBuyers",
    access: `${BASE} + customers.view (clients que vous pouvez voir)`,
    text: bi(
      {
        definition: "Les clients qui ont acheté pour la première fois sur la période.",
        calculation: "Clients dont la toute première commande (tout l'historique, tous statuts) tombe dans la période ET qui ont au moins une commande valide (ni annulée, ni en échec, ni retournée, ni remboursée) dans la période.",
        scope: "Clients que votre rôle vous permet de voir. La date de création ou d'import de la fiche client n'entre pas en compte.",
        period: PERIOD.fr,
        filters: PERIOD_ONLY_FILTER.fr,
        example: "3 clients commandent ce mois : 2 pour la première fois, 1 avait déjà commandé en juin → 2. Un 4e dont la 1re commande du mois est annulée n'est pas compté.",
        interpretation: "Mesure l'acquisition : combien d'acheteurs nouveaux la période a apportés.",
        caveats: "Un client importé de WooCommerce l'an dernier qui commande aujourd'hui pour la 1re fois est un nouveau client.",
      },
      {
        definition: "الزبائن الذين اشتروا لأول مرة خلال الفترة.",
        calculation: "الزبائن الذين يقع أول طلب لهم على الإطلاق (كل السجل، بجميع الحالات) داخل الفترة، ولهم طلب صالح واحد على الأقل (غير ملغى وغير فاشل وغير مُرجَع وغير مسترَدّ) خلال الفترة.",
        scope: "الزبائن الذين يسمح لك دورك برؤيتهم. تاريخ إنشاء بطاقة الزبون أو استيرادها لا يُعتدّ به.",
        period: PERIOD.ar,
        filters: PERIOD_ONLY_FILTER.ar,
        example: "3 زبائن طلبوا هذا الشهر: 2 لأول مرة، و1 سبق أن طلب في يونيو ← 2. زبون رابع (4e) طلبه الأول هذا الشهر ملغى لا يُحتسب.",
        interpretation: "يقيس الاستقطاب: عدد المشترين الجدد الذين جلبتهم الفترة.",
        caveats: "الزبون المستورد من WooCommerce في السنة الماضية والذي يطلب اليوم للمرة 1 يُعدّ زبونًا جديدًا.",
      }
    ),
  },

  // -------------------------------------------------------------- Rentabilité
  charges: {
    labels: ["Charges"],
    source: "src/lib/profitability.ts — computePeriodProfitability (chargesTotal = expensesTotal + deliveryCostTotal)",
    access: FINANCE,
    text: bi(
      {
        definition: "Ce que la période a coûté hors marchandises : dépenses saisies et livraison.",
        calculation: `Dépenses enregistrées dans /depenses (publicité et autres catégories) + coût de livraison des commandes de la période (livraison, frais de retour, frais d'échec, corrections manuelles, toutes tentatives). ${TREND.fr}`,
        scope: "Livraison : hors expéditions annulées et commandes annulées. Dépenses : toutes, sans notion de canal.",
        period: "Dépenses : leur propre date. Livraison : date de commande des commandes expédiées. Période choisie en haut de page.",
        filters: ONLINE_FILTER.fr,
        example: `${mad(E.finance.expenses)} de publicité + livraison 4 × 35 + 20 (échec CMD-105) + 20 (retour CMD-106) = ${mad(E.finance.deliveryCost)} → ${mad(charges)}.`,
        interpretation: "Les coûts déjà déduits du bénéfice net, à côté de lui.",
        caveats: "N'inclut ni le coût des marchandises, ni les commissions. Le coût de livraison est celui payé au transporteur, pas les frais facturés au client.",
      },
      {
        definition: "ما كلّفته الفترة خارج البضاعة: المصاريف المُدخلة والتوصيل.",
        calculation: `المصاريف المسجّلة في /depenses (إشهار وفئات أخرى) + كلفة توصيل طلبات الفترة (التوصيل ورسوم الإرجاع ورسوم الفشل والتصحيحات اليدوية، مع كل المحاولات). ${TREND.ar}`,
        scope: "التوصيل: باستثناء الشحنات الملغاة والطلبات الملغاة. المصاريف: كلها، دون مفهوم القناة.",
        period: "المصاريف: بتاريخها الخاص. التوصيل: تاريخ الطلب للطلبات المشحونة. الفترة المختارة أعلى الصفحة.",
        filters: ONLINE_FILTER.ar,
        example: `${mad(E.finance.expenses)} إشهار + توصيل 4 × 35 + 20 (فشل CMD-105) + 20 (إرجاع CMD-106) = ${mad(E.finance.deliveryCost)} ← ${mad(charges)}.`,
        interpretation: "التكاليف المخصومة أصلًا من الربح الصافي، معروضة بجانبه.",
        caveats: "لا تشمل كلفة البضاعة ولا العمولات. كلفة التوصيل هي المؤدّاة لشركة التوصيل، وليست الرسوم المفوترة للزبون.",
      }
    ),
  },
  netProfit: {
    labels: ["Bénéfice net"],
    sharedWith: "netProfit",
    source: "src/lib/profitability.ts — computePeriodProfitability (netProfit, cogsComplete)",
    access: FINANCE,
    text: withDashboardFilters(ANALYTICS_METRICS.netProfit.text, ONLINE_FILTER),
  },

  // ------------------------------------------------------------------- Stock
  stockOnHand: {
    labels: ["Stock physique", "Disponible", "Réservé"],
    source: "src/lib/queries/inventory.ts — getStockOverview",
    access: `${BASE} + inventory.view (vos emplacements)`,
    text: bi(
      {
        definition: "Le nombre d'unités présentes dans vos emplacements, et comment il se répartit entre réservé et disponible.",
        calculation: "Stock physique = Σ quantités en stock de toutes les lignes de stock. Réservé = Σ quantités réservées (commandes en cours). Disponible = physique − réservé (jamais négatif). La barre montre la part de chacun.",
        scope: "Emplacements actifs auxquels vous avez accès (tous pour un propriétaire ou un administrateur ; sinon vos emplacements assignés — aucun assigné = 0). Toutes les références confondues.",
        period: "Aucune : c'est l'état du stock à l'instant de l'affichage.",
        filters: NO_FILTER.fr,
        example: `${stockLines[0].location} ${stockLines[0].onHand} dont ${stockLines[0].reserved} réservés, ${stockLines[1].location} ${stockLines[1].onHand} dont ${stockLines[1].reserved} → physique ${stockOnHand}, réservé ${stockReserved}, disponible ${stockAvailable}.`,
        interpretation: "Une quantité, pas une valeur : aucun prix ni coût n'est appliqué.",
        caveats: "Additionne des unités de produits différents : utile pour suivre une tendance, pas pour comparer deux produits.",
      },
      {
        definition: "عدد الوحدات الموجودة في مواقعك، وكيف تتوزّع بين المحجوز والمتاح.",
        calculation: "المخزون الفعلي = Σ الكميات الموجودة في كل أسطر المخزون. المحجوز = Σ الكميات المحجوزة (طلبات جارية). المتاح = الفعلي − المحجوز (لا يكون سالبًا أبدًا). يُظهر الشريط حصّة كلٍّ منهما.",
        scope: "المواقع النشطة المسموح لك بها (كلها للمالك أو المسؤول؛ وإلا مواقعك المعيّنة — وبلا تعيين تكون النتيجة 0). جميع المراجع مجتمعة.",
        period: "لا توجد: إنها حالة المخزون لحظة العرض.",
        filters: NO_FILTER.ar,
        example: `${stockLines[0].location} ${stockLines[0].onHand} منها ${stockLines[0].reserved} محجوزة، ${stockLines[1].location} ${stockLines[1].onHand} منها ${stockLines[1].reserved} ← الفعلي ${stockOnHand}، المحجوز ${stockReserved}، المتاح ${stockAvailable}.`,
        interpretation: "كمية وليست قيمة: لا يُطبَّق أي سعر أو كلفة.",
        caveats: "يجمع وحدات منتجات مختلفة: مفيد لتتبّع الاتجاه، لا لمقارنة منتجين.",
      }
    ),
  },
  lowStock: {
    labels: ["Produits en stock faible"],
    source: "src/lib/queries/inventory.ts — getLowStockCountForViewer / getLowStockCount (LOW_STOCK_CONDITION)",
    access: `${BASE} + inventory.view (vos emplacements)`,
    text: bi(
      {
        definition: "Les articles qui risquent la rupture.",
        calculation: "Nombre de lignes de stock (un article dans un emplacement actif) dont le disponible — en stock moins réservé — est inférieur ou égal au seuil d'alerte du produit (celui du produit parent pour une variante ; 0 si aucun seuil). Même règle que les alertes de stock.",
        scope: "Emplacements actifs auxquels vous avez accès (tous pour un propriétaire ou un administrateur ; sinon vos emplacements assignés).",
        period: "Aucune : état du stock à l'instant de l'affichage.",
        filters: NO_FILTER.fr,
        example: `Seuil ${low.threshold}, ${low.onHand} en stock dont ${low.reserved} réservés → ${lowAvailable} disponibles ≤ ${low.threshold} : stock faible (1 ligne).`,
        interpretation: "Combien de lignes de stock demandent un réapprovisionnement ou un transfert.",
        caveats: "Un article présent dans 2 emplacements compte 2 fois (une par emplacement). Sans seuil, un article à 0 disponible compte aussi.",
      },
      {
        definition: "القطع المهدّدة بنفاد المخزون.",
        calculation: "عدد أسطر المخزون (قطعة في موقع نشط) التي يكون متاحها — الموجود ناقص المحجوز — أقل من عتبة التنبيه الخاصة بالمنتج أو مساويًا لها (عتبة المنتج الأب بالنسبة للمتغيّر؛ و0 إن لم توجد عتبة). القاعدة نفسها المعتمدة في تنبيهات المخزون.",
        scope: "المواقع النشطة المسموح لك بها (كلها للمالك أو المسؤول؛ وإلا مواقعك المعيّنة).",
        period: "لا توجد: حالة المخزون لحظة العرض.",
        filters: NO_FILTER.ar,
        example: `العتبة ${low.threshold}، و${low.onHand} في المخزون منها ${low.reserved} محجوزة ← ${lowAvailable} متاحة ≤ ${low.threshold}: مخزون ضعيف (1 سطر).`,
        interpretation: "عدد أسطر المخزون التي تحتاج إلى تزويد أو تحويل.",
        caveats: "القطعة الموجودة في موقعين (2) تُحتسب مرتين (مرة لكل موقع). وبدون عتبة، تُحتسب أيضًا القطعة التي متاحها 0.",
      }
    ),
  },

  // -------------------------------------------------------------- Opérations
  toConfirm: {
    labels: ["À confirmer"],
    source: "src/lib/queries/order-confirmation.ts — getConfirmationDashboardSummary (toConfirm)",
    access: `${BASE} + orders.confirm`,
    text: bi(
      {
        definition: "Les commandes qui attendent encore leur appel de confirmation.",
        calculation: "Nombre de commandes au statut « Nouvelle », aujourd'hui.",
        scope: "Toutes les commandes en ligne au statut « Nouvelle », quelle que soit leur date (même anciennes).",
        period: "Aucune : c'est la file d'attente actuelle.",
        filters: NO_FILTER.fr,
        example: `Boutique Exemple : ${nouvelles.map((o) => o.ref).join(" et ")} sont « Nouvelle » → ${nouvelles.length}.`,
        interpretation: "La charge de travail restante de l'équipe de confirmation.",
        caveats: "Différent de la liste « Commandes nécessitant une action », limitée aux 21 derniers jours et aux 6 plus anciennes.",
      },
      {
        definition: "الطلبات التي ما زالت تنتظر مكالمة التأكيد.",
        calculation: "عدد الطلبات بحالة « Nouvelle » اليوم.",
        scope: "كل الطلبات الإلكترونية بحالة « Nouvelle » مهما كان تاريخها (حتى القديمة).",
        period: "لا توجد: إنها قائمة الانتظار الحالية.",
        filters: NO_FILTER.ar,
        example: `Boutique Exemple: ${nouvelles.map((o) => o.ref).join(" و")} بحالة « Nouvelle » ← ${nouvelles.length}.`,
        interpretation: "عبء العمل المتبقّي لفريق التأكيد.",
        caveats: "يختلف عن قائمة « Commandes nécessitant une action » المحصورة في آخر 21 يومًا وفي أقدم 6 طلبات.",
      }
    ),
  },
  confirmedThisMonth: {
    labels: ["Confirmées ce mois"],
    source: "src/lib/queries/order-confirmation.ts — getConfirmationDashboardSummary (confirmedThisMonth, countConfirmedOrders)",
    access: `${BASE} + orders.confirm`,
    text: bi(
      {
        definition: "Le nombre de commandes confirmées depuis le 1er du mois.",
        calculation: "Commandes distinctes ayant au moins une tentative d'appel « Confirmé » enregistrée depuis le 1er du mois. Une commande appelée plusieurs fois compte une seule fois.",
        scope: "Toutes les commandes, quel que soit leur statut actuel (une commande confirmée puis annulée reste comptée).",
        period: "Toujours le mois calendaire en cours (fuseau horaire de la boutique), d'après la date de la tentative d'appel — pas la date de la commande.",
        filters: NO_FILTER.fr,
        example: `Boutique Exemple : ${EXAMPLE_ATTEMPTS.CONFIRME} tentatives « Confirmé » ce mois sur ${E.confirmed} commandes (CMD-101 à CMD-107) → ${E.confirmed}. 3 appels le même jour sur une commande, dont 1 « Confirmé » → 1.`,
        interpretation: "Le rythme de confirmation du mois.",
        caveats: "Ignore la période choisie en haut de page : c'est toujours « ce mois ».",
      },
      {
        definition: "عدد الطلبات المؤكَّدة منذ اليوم 1 من الشهر.",
        calculation: "الطلبات المتميّزة التي لها محاولة اتصال واحدة على الأقل بنتيجة « Confirmé » مسجّلة منذ اليوم 1 من الشهر. الطلب الذي اتُّصل به عدة مرات يُحتسب مرة واحدة.",
        scope: "كل الطلبات مهما كانت حالتها الحالية (الطلب المؤكَّد ثم الملغى يبقى محتسبًا).",
        period: "دائمًا الشهر التقويمي الحالي (المنطقة الزمنية للمتجر)، حسب تاريخ محاولة الاتصال — وليس تاريخ الطلب.",
        filters: NO_FILTER.ar,
        example: `Boutique Exemple: ${EXAMPLE_ATTEMPTS.CONFIRME} محاولات « Confirmé » هذا الشهر على ${E.confirmed} طلبات (من CMD-101 إلى CMD-107) ← ${E.confirmed}. 3 مكالمات في اليوم نفسه على طلب واحد، منها 1 « Confirmé » ← 1.`,
        interpretation: "وتيرة التأكيد خلال الشهر.",
        caveats: "يتجاهل الفترة المختارة أعلى الصفحة: هو دائمًا « ce mois ».",
      }
    ),
  },
  toRecall: {
    labels: ["À rappeler"],
    source: "src/lib/queries/order-confirmation.ts — getConfirmationDashboardSummary (toRecall)",
    access: `${BASE} + orders.confirm`,
    text: bi(
      {
        definition: "Les commandes à confirmer qui ont déjà été appelées sans succès.",
        calculation: "Nombre de commandes au statut « Nouvelle » ayant au moins une tentative d'appel enregistrée. C'est une partie de « À confirmer ».",
        scope: "Toutes les commandes « Nouvelle », quelle que soit leur date.",
        period: "Aucune : file d'attente actuelle.",
        filters: NO_FILTER.fr,
        example: `${toRecall.map((o) => o.ref).join(", ")} (1 appel sans réponse) → ${toRecall.length} ; ${neverCalled.map((o) => o.ref).join(", ")} (jamais appelée) n'y est pas → ${toRecall.length} sur ${nouvelles.length} à confirmer.`,
        interpretation: "Les clients à relancer en priorité.",
      },
      {
        definition: "الطلبات في انتظار التأكيد التي اتُّصل بها سابقًا دون نجاح.",
        calculation: "عدد الطلبات بحالة « Nouvelle » التي لها محاولة اتصال مسجّلة واحدة على الأقل. وهي جزء من « À confirmer ».",
        scope: "كل الطلبات بحالة « Nouvelle » مهما كان تاريخها.",
        period: "لا توجد: قائمة الانتظار الحالية.",
        filters: NO_FILTER.ar,
        example: `${toRecall.map((o) => o.ref).join("، ")} (1 مكالمة دون رد) ← ${toRecall.length}؛ و${neverCalled.map((o) => o.ref).join("، ")} (لم يُتّصل به قط) غير محتسب ← ${toRecall.length} من أصل ${nouvelles.length} في انتظار التأكيد.`,
        interpretation: "الزبائن الذين يجب معاودة الاتصال بهم أولًا.",
      }
    ),
  },
  commissionEarned: {
    labels: ["Gagnée ce mois"],
    source: "src/lib/queries/commissions.ts — getCommissionDashboardSummary (earnedThisMonth)",
    access: `${BASE} + commissions.view`,
    text: bi(
      {
        definition: "Les commissions acquises par les agents de confirmation depuis le 1er du mois.",
        calculation: "Somme des écritures « gagnée » du registre des commissions créées ce mois-ci, tous agents confondus. Une écriture naît quand une commande attribuée à un agent passe à « Livrée » ; son montant est le tarif fixe par commande de l'agent.",
        scope: "Tous les agents. Les annulations d'écritures (commande sortie de « Livrée ») ne sont PAS déduites ici.",
        period: "Toujours le mois calendaire en cours, d'après la date de l'écriture — pas la date de la commande.",
        filters: NO_FILTER.fr,
        example: `${EXAMPLE_COMMISSION.agent}, ${EXAMPLE_COMMISSION.ratePerOrder} MAD par commande livrée, ${EXAMPLE_COMMISSION.earnedEntries} livraisons ce mois → ${mad(commissionEarned)}, même si ${EXAMPLE_COMMISSION.reversedEntries} annulation de ${mad(commissionReversed)} a été enregistrée.`,
        interpretation: "Ce que les agents ont gagné ce mois, avant annulations et indépendamment des paiements.",
        caveats: "Ignore la période choisie en haut de page. Affiché dans la devise du premier agent ; des agents payés dans d'autres devises sont additionnés tels quels.",
      },
      {
        definition: "العمولات التي استحقّها وكلاء التأكيد منذ اليوم 1 من الشهر.",
        calculation: "مجموع قيود « gagnée » في سجل العمولات المنشأة هذا الشهر، لكل الوكلاء. يُنشأ القيد عندما ينتقل طلب منسوب إلى وكيل إلى « Livrée »، ومبلغه هو التعريفة الثابتة لكل طلب لدى الوكيل.",
        scope: "كل الوكلاء. إلغاءات القيود (خروج الطلب من « Livrée ») لا تُخصم هنا.",
        period: "دائمًا الشهر التقويمي الحالي، حسب تاريخ القيد — وليس تاريخ الطلب.",
        filters: NO_FILTER.ar,
        example: `${EXAMPLE_COMMISSION.agent}، ${EXAMPLE_COMMISSION.ratePerOrder} MAD لكل طلب مسلَّم، ${EXAMPLE_COMMISSION.earnedEntries} عمليات تسليم هذا الشهر ← ${mad(commissionEarned)}، حتى لو سُجّل ${EXAMPLE_COMMISSION.reversedEntries} إلغاء بقيمة ${mad(commissionReversed)}.`,
        interpretation: "ما استحقّه الوكلاء هذا الشهر، قبل الإلغاءات وبصرف النظر عن الأداء.",
        caveats: "يتجاهل الفترة المختارة أعلى الصفحة. يُعرض بعملة الوكيل الأول؛ والوكلاء المؤدّى لهم بعملات أخرى يُجمعون كما هم.",
      }
    ),
  },
  commissionRemaining: {
    labels: ["Reste à payer"],
    source: "src/lib/queries/commissions.ts — getCommissionDashboardSummary (remainingTotal) ; src/lib/commissions.ts — getAgentCommissionTotals",
    access: `${BASE} + commissions.view`,
    text: bi(
      {
        definition: "Les commissions encore dues aux agents de confirmation, tout historique confondu.",
        calculation: "Pour chaque agent (actif ou non) : écritures gagnées − écritures annulées (registre complet) − montants payés des relevés « Payé » ; puis somme sur tous les agents.",
        scope: "Tous les agents, actifs ou désactivés.",
        period: "Aucune : solde à l'instant de l'affichage, depuis le début.",
        filters: NO_FILTER.fr,
        example: `Un agent : ${mad(lifetime.earned)} gagnés, ${mad(lifetime.reversed)} annulés, ${mad(lifetime.paid)} payés → ${mad(remaining)} restants.`,
        interpretation: "Ce que la boutique doit encore verser. Affiché en orange tant qu'il est supérieur à 0.",
        caveats: "Affiché dans la devise du premier agent ; des agents payés dans d'autres devises sont additionnés tels quels.",
      },
      {
        definition: "العمولات التي ما زالت مستحقّة لوكلاء التأكيد، عن كامل السجل.",
        calculation: "لكل وكيل (نشط أو غير نشط): القيود المستحقّة − القيود الملغاة (السجل كاملًا) − المبالغ المؤدّاة في الكشوف بحالة « Payé »؛ ثم المجموع على كل الوكلاء.",
        scope: "كل الوكلاء، النشطين والمعطَّلين.",
        period: "لا توجد: الرصيد لحظة العرض، منذ البداية.",
        filters: NO_FILTER.ar,
        example: `وكيل واحد: ${mad(lifetime.earned)} مستحقّة، و${mad(lifetime.reversed)} ملغاة، و${mad(lifetime.paid)} مؤدّاة ← ${mad(remaining)} متبقّية.`,
        interpretation: "ما يزال على المتجر دفعه. يظهر باللون البرتقالي ما دام أكبر من 0.",
        caveats: "يُعرض بعملة الوكيل الأول؛ والوكلاء المؤدّى لهم بعملات أخرى يُجمعون كما هم.",
      }
    ),
  },
  deliveryRate: {
    labels: ["Taux de livraison réussie"],
    source: "src/lib/queries/delivery.ts — getDeliveryStats ; src/lib/metrics/formulas.ts — orderDeliveryOutcome, deliveryOutcomeRate",
    access: `${BASE} + delivery.view`,
    text: bi(
      {
        definition: "La part des colis arrivés au bout qui ont été livrés.",
        calculation: "Livrés ÷ (livrés + échecs + retours) × 100, une décimale. Chaque colis prend le résultat de son expédition, sauf si la commande est « Retour » ou « Remboursée » : il compte alors comme retour (même livré). Sous le chiffre : livrés sur terminés.",
        scope: "Expéditions actuelles uniquement : une expédition annulée puis remplacée par un renvoi ne compte plus, et les tentatives de création API jamais remises au transporteur sont ignorées. Les colis en route ou annulés n'ont pas de résultat : hors calcul.",
        period: "Date de CRÉATION de l'expédition dans la période choisie en haut de page (pas la date de la commande).",
        filters: PERIOD_ONLY_FILTER.fr,
        example: `${parcels.length} colis créés : ${outcomes.delivered} livrés, ${outcomes.failed} échec (CMD-105), ${outcomes.returned} retourné (CMD-106), ${inTransit} en route (CMD-104) → ${outcomes.delivered} ÷ ${finished} = ${successLabel} ; « ${outcomes.delivered} livrée(s) sur ${finished} terminée(s) ».`,
        interpretation: "La qualité de livraison sur les colis dont on connaît l'issue.",
        caveats: `Le taux bouge à mesure que les colis en route arrivent. Sans colis terminé : « Aucune livraison terminée sur la période » (pas 0 %). Peut différer du taux de /analyses, qui place les commandes par leur date de commande (ici, commandes et colis tombent dans la même période : les deux donnent ${asPct(successRate)} %).`,
      },
      {
        definition: "نسبة الطرود التي اكتمل مسارها وتمّ تسليمها.",
        calculation: "المسلَّمة ÷ (المسلَّمة + الفاشلة + المُرجَعة) × 100، برقم عشري واحد. يأخذ كل طرد نتيجة شحنته، إلا إذا كان الطلب « Retour » أو « Remboursée » فيُحتسب إرجاعًا (حتى لو سُلِّم). تحت الرقم: المسلَّمة من أصل المنتهية.",
        scope: "الشحنات الحالية فقط: الشحنة الملغاة التي عُوِّضت بإرسال جديد لم تعد تُحتسب، وتُهمَل محاولات الإنشاء عبر API التي لم تصل إلى شركة التوصيل. الطرود التي في الطريق أو الملغاة ليس لها نتيجة فلا تدخل في الحساب.",
        period: "تاريخ إنشاء الشحنة داخل الفترة المختارة أعلى الصفحة (وليس تاريخ الطلب).",
        filters: PERIOD_ONLY_FILTER.ar,
        example: `${parcels.length} طرود أُنشئت: ${outcomes.delivered} مسلَّمة، و${outcomes.failed} فاشل (CMD-105)، و${outcomes.returned} مُرجَع (CMD-106)، و${inTransit} في الطريق (CMD-104) ← ${outcomes.delivered} ÷ ${finished} = ${successLabel}؛ « ${outcomes.delivered} livrée(s) sur ${finished} terminée(s) ».`,
        interpretation: "جودة التسليم بالنسبة للطرود المعروفة نتيجتها.",
        caveats: `تتغيّر النسبة كلما وصلت الطرود التي في الطريق. وبدون أي طرد منتهٍ يظهر « Aucune livraison terminée sur la période » (وليس 0 %). قد تختلف عن نسبة /analyses التي تعتمد تاريخ الطلب (هنا تقع الطلبات والطرود في الفترة نفسها، فتعطي النسبتان ${asPct(successRate)} %).`,
      }
    ),
  },

  // ------------------------------------------------------------------ Ventes
  revenueTrend: {
    labels: ["Chiffre d'affaires — graphique mensuel"],
    source: "src/lib/queries/dashboard.ts — getRevenueTrend",
    access: FINANCE,
    text: bi(
      {
        definition: "Le chiffre d'affaires en ligne mois par mois, sur l'année en cours ou l'année dernière.",
        calculation: "Pour chaque mois : Σ totaux des commandes valides passées ce mois − leurs remboursements « Complété ». Même règle que la carte « Chiffre d'affaires ».",
        scope: REVENUE_ORDERS.fr,
        period: "« Cette année » : de janvier au mois en cours (inclus) ; « Année dernière » : les 12 mois de l'an passé. Mois découpés dans le fuseau horaire de la boutique, par date de commande. N'utilise PAS la période choisie en haut de page.",
        filters: "Seuls les boutons « Cette année » / « Année dernière » du graphique le modifient. Le sélecteur Tous / En ligne / Magasin ne fait qu'afficher ou masquer le graphique.",
        example: `Boutique Exemple, barre de septembre : ${mad(E.grossRevenue)} − ${mad(E.revenueRefunds)} = ${mad(E.netRevenue)}.`,
        interpretation: "La saisonnalité et la tendance des ventes en ligne.",
        caveats: "Le mois en cours n'est pas terminé : sa barre est partielle.",
      },
      {
        definition: "رقم المعاملات الإلكتروني شهرًا بشهر، للسنة الحالية أو للسنة الماضية.",
        calculation: "لكل شهر: Σ مبالغ الطلبات الصالحة المسجّلة في ذلك الشهر − استرداداتها بحالة « Complété ». القاعدة نفسها المعتمدة في بطاقة « Chiffre d'affaires ».",
        scope: REVENUE_ORDERS.ar,
        period: "« Cette année »: من يناير إلى الشهر الحالي (ضمنه)؛ « Année dernière »: الأشهر 12 من السنة الماضية. تُحدَّد الأشهر حسب المنطقة الزمنية للمتجر وبتاريخ الطلب. لا يستعمل الفترة المختارة أعلى الصفحة.",
        filters: "لا يغيّره إلا زرّا « Cette année » / « Année dernière » في الرسم. محدِّد Tous / En ligne / Magasin يُظهر الرسم أو يخفيه فقط.",
        example: `Boutique Exemple، عمود سبتمبر: ${mad(E.grossRevenue)} − ${mad(E.revenueRefunds)} = ${mad(E.netRevenue)}.`,
        interpretation: "موسمية المبيعات الإلكترونية واتجاهها.",
        caveats: "الشهر الحالي لم ينتهِ بعد: عموده جزئي.",
      }
    ),
  },
  topSelling: {
    labels: ["Meilleures ventes"],
    source: "src/lib/queries/analytics.ts — getTopSellingUnits (5)",
    access: `${BASE} + orders.view`,
    text: bi(
      {
        definition: "Les 5 articles les plus vendus en ligne sur la période, en quantité.",
        calculation: "Par produit (et par variante) : Σ quantités des lignes des commandes valides ; classement par quantité décroissante, 5 premiers. Le montant affiché sous la quantité = Σ totaux de ces lignes (prix × quantité, remise de ligne déduite).",
        scope: "Commandes valides (ni annulées, ni en échec, ni retournées, ni remboursées). Lignes sans produit lié ignorées. Jamais les ventes en magasin.",
        period: PERIOD.fr,
        filters: "Seule la période choisie en haut de page le modifie.",
        example: `Boutique Exemple : ${ranked.map((p) => `${p.product} ${p.units} (${mad(p.revenue)})`).join(", ")}.`,
        interpretation: "Les articles qui portent le volume — à surveiller en stock.",
        caveats: "Le montant ne comprend ni frais de livraison, ni remise globale, ni remboursements. Un produit à variantes peut apparaître une fois par variante.",
      },
      {
        definition: "القطع الخمس (5) الأكثر مبيعًا إلكترونيًا خلال الفترة، من حيث الكمية.",
        calculation: "لكل منتج (ولكل متغيّر): Σ كميات أسطر الطلبات الصالحة؛ الترتيب تنازليًا حسب الكمية، والخمسة (5) الأوائل. المبلغ المعروض تحت الكمية = Σ مبالغ هذه الأسطر (السعر × الكمية بعد خصم تخفيض السطر).",
        scope: "الطلبات الصالحة (غير الملغاة وغير الفاشلة وغير المُرجَعة وغير المسترَدّة). تُهمَل الأسطر غير المرتبطة بمنتج. لا تشمل أبدًا مبيعات المتجر.",
        period: PERIOD.ar,
        filters: "لا تغيّره إلا الفترة المختارة أعلى الصفحة.",
        example: `Boutique Exemple: ${ranked.map((p) => `${p.product} ${p.units} (${mad(p.revenue)})`).join("، ")}.`,
        interpretation: "القطع التي تحمل الحجم — يجب مراقبة مخزونها.",
        caveats: "لا يشمل المبلغ رسوم التوصيل ولا التخفيض الإجمالي ولا الاستردادات. قد يظهر المنتج ذو المتغيّرات مرة لكل متغيّر.",
      }
    ),
  },

  // ---------------------------------------------------------------- Activité
  ordersRequiringAction: {
    labels: ["Commandes nécessitant une action"],
    source: "src/lib/queries/dashboard.ts — getDashboardData (ordersRequiringAction)",
    access: `${BASE} + orders.view`,
    text: bi(
      {
        definition: "Les commandes récentes sur lesquelles personne n'a encore agi.",
        calculation: "Commandes au statut « Nouvelle » passées dans les 21 derniers jours, de la plus ancienne à la plus récente, 6 au maximum.",
        scope: "Statut « Nouvelle » uniquement : une commande « Confirmée » est déjà prise en charge. Au-delà de 21 jours, une commande « Nouvelle » est considérée comme de l'historique (par exemple une commande importée).",
        period: "Fenêtre glissante des 21 derniers jours, quelle que soit la période choisie.",
        filters: NO_FILTER.fr,
        example: `${nouvelles.map((o) => o.ref).join(" et ")} (« Nouvelle », passées ce mois) apparaissent, la plus ancienne en premier ; une commande « Nouvelle » passée il y a 30 jours n'apparaît pas.`,
        interpretation: "Par où commencer : les commandes qui attendent depuis le plus longtemps.",
        caveats: "Ce n'est pas un total : pour le nombre de commandes à confirmer, voir « À confirmer ».",
      },
      {
        definition: "الطلبات الحديثة التي لم يتصرّف فيها أحد بعد.",
        calculation: "الطلبات بحالة « Nouvelle » المسجّلة خلال آخر 21 يومًا، من الأقدم إلى الأحدث، وبحدّ أقصى 6.",
        scope: "حالة « Nouvelle » فقط: الطلب « Confirmée » تمّ التكفّل به. وبعد 21 يومًا يُعدّ الطلب « Nouvelle » من الأرشيف (مثل طلب مستورد).",
        period: "نافذة متحرّكة لآخر 21 يومًا، مهما كانت الفترة المختارة.",
        filters: NO_FILTER.ar,
        example: `${nouvelles.map((o) => o.ref).join(" و")} (« Nouvelle »، مسجّلة هذا الشهر) تظهر، والأقدم أولًا؛ أمّا طلب « Nouvelle » مسجّل قبل 30 يومًا فلا يظهر.`,
        interpretation: "من أين تبدأ: الطلبات التي تنتظر منذ أطول مدة.",
        caveats: "ليست مجموعًا: لعدد الطلبات في انتظار التأكيد، انظر « À confirmer ».",
      }
    ),
  },
  recentOrders: {
    labels: ["Commandes récentes"],
    source: "src/lib/queries/dashboard.ts — getDashboardData (recentOrders)",
    access: `${BASE} + orders.view`,
    text: bi(
      {
        definition: "Les dernières commandes reçues.",
        calculation: "Les 6 commandes les plus récentes par date de commande, tous statuts confondus. Chaque ligne affiche le total de la commande (livraison facturée comprise).",
        scope: "Toutes les commandes en ligne, annulées comprises.",
        period: "Aucune : toujours les 6 dernières, quelle que soit la période choisie.",
        filters: NO_FILTER.fr,
        example: `Boutique Exemple, commandes passées dans l'ordre de leur numéro : CMD-110 à CMD-105, de la plus récente à la plus ancienne (CMD-108, annulée, en fait partie).`,
        interpretation: "Un aperçu du flux de commandes entrant.",
      },
      {
        definition: "آخر الطلبات المستلمة.",
        calculation: "آخر 6 طلبات حسب تاريخ الطلب، بجميع الحالات. يعرض كل سطر مبلغ الطلب (بما فيه رسوم التوصيل المفوترة).",
        scope: "كل الطلبات الإلكترونية، بما فيها الملغاة.",
        period: "لا توجد: دائمًا آخر 6 طلبات، مهما كانت الفترة المختارة.",
        filters: NO_FILTER.ar,
        example: `Boutique Exemple، والطلبات مسجّلة بترتيب أرقامها: من CMD-110 إلى CMD-105، من الأحدث إلى الأقدم (ومنها CMD-108 الملغى).`,
        interpretation: "لمحة عن تدفّق الطلبات الواردة.",
      }
    ),
  },
  recentActivity: {
    labels: ["Activité récente"],
    source: "src/lib/queries/dashboard.ts — getDashboardData (recentAuditEvents) ; src/lib/audit-classification.ts — DASHBOARD_HIDDEN_AUDIT_ACTIONS",
    access: `${BASE} + audit.view`,
    text: bi(
      {
        definition: "Les 8 derniers événements du journal d'audit qui concernent l'activité, la configuration ou la sécurité.",
        calculation: "Les 8 événements les plus récents du journal, hors événements techniques et routiniers (connexions et déconnexions réussies, synchronisations, exports, requêtes IA…). Les connexions échouées et les changements d'accès restent visibles.",
        scope: "Limité à vos canaux : sans canal En ligne (ou Magasin), les événements de cette activité ne sont pas montrés. Le journal d'audit, lui, montre tout.",
        period: "Aucune : toujours les 8 derniers, quelle que soit la période choisie.",
        filters: NO_FILTER.fr,
        example: "10 connexions réussies puis 1 modification des paramètres et 1 commande confirmée → la liste montre la modification et la confirmation, pas les 10 connexions.",
        interpretation: "Qui a fait quoi récemment, sans le bruit technique.",
      },
      {
        definition: "آخر 8 أحداث في سجل التدقيق تخصّ النشاط أو الإعدادات أو الأمان.",
        calculation: "آخر 8 أحداث في السجل، باستثناء الأحداث التقنية والروتينية (تسجيلات الدخول والخروج الناجحة، والمزامنات، والتصديرات، وطلبات الذكاء الاصطناعي…). تبقى محاولات الدخول الفاشلة وتغييرات الصلاحيات ظاهرة.",
        scope: "محصور في قنواتك: بدون قناة En ligne (أو Magasin) لا تظهر أحداث ذلك النشاط. أمّا سجل التدقيق فيعرض كل شيء.",
        period: "لا توجد: دائمًا آخر 8 أحداث، مهما كانت الفترة المختارة.",
        filters: NO_FILTER.ar,
        example: "10 تسجيلات دخول ناجحة ثم 1 تعديل في الإعدادات و1 طلب مؤكَّد ← تعرض القائمة التعديل والتأكيد، وليس تسجيلات الدخول الـ10.",
        interpretation: "من فعل ماذا مؤخرًا، دون الضجيج التقني.",
      }
    ),
  },
} satisfies Record<string, DashboardMetricDoc>;

export type DashboardMetricId = keyof typeof DASHBOARD_METRICS;

export const DASHBOARD_METRIC_IDS = Object.keys(DASHBOARD_METRICS) as DashboardMetricId[];
