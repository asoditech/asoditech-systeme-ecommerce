import { requirePermission } from "@/lib/auth/guards";
import { analyticsAccess, canOpenSection, type AnalyticsAccess } from "@/lib/analytics/access";
import { contextFor } from "@/lib/analytics/context";
import { sourceLabel } from "@/lib/analytics/filters";
import { getOnlineOverview, getOnlineRevenueSeries, getConfirmationAnalytics, getDeliveryAnalytics, getOnlineSourceFunnel } from "@/lib/analytics/queries/online";
import { getOnlineProductPerformance, getStoreProductPerformance, type ProductPerformance } from "@/lib/analytics/queries/products";
import { getCommissionAnalytics } from "@/lib/analytics/queries/commissions";
import { getStoreOverview } from "@/lib/analytics/queries/store";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { csvDocument, csvDocumentResponse, type CsvSection } from "@/lib/reports/csv";
import { CONFIRMATION_OUTCOME_LABELS } from "@/lib/status-labels";

/**
 * CSV exports of the analytics module — `/analyses/export/<type>` with the
 * page's own query string (docs/adr/0051). Same entry point, same access
 * resolution and same query functions as the screen: a section the viewer
 * may not open is a 403, store rows are scoped to the viewer's stores and
 * locations, and cost / gross profit columns exist in the file ONLY when the
 * viewer holds `finance.view` — they are not computed otherwise, so there is
 * nothing to strip.
 */

const TYPES: Record<string, (a: AnalyticsAccess) => boolean> = {
  revenus: (a) => a.online,
  confirmation: (a) => canOpenSection(a, "confirmation"),
  livraison: (a) => canOpenSection(a, "delivery"),
  produits: (a) => canOpenSection(a, "products"),
  commissions: (a) => canOpenSection(a, "commissions"),
  canaux: (a) => canOpenSection(a, "sources"),
};

const pct = (v: number | null) => (v === null ? "" : v);
const hours = (v: number | null) => (v === null ? "" : v);

function productSection(heading: string, parent: string, p: ProductPerformance, withFinance: boolean): CsvSection[] {
  const fin = (r: { cogs?: number | null; grossProfit?: number | null }) => (withFinance ? [r.cogs ?? "coût manquant", r.grossProfit ?? "coût manquant"] : []);
  const finHead = withFinance ? ["Coût", "Bénéfice brut"] : [];
  return [
    {
      heading: `${heading} — par produit et variation`,
      headers: ["Produit", "Variation", "Catégorie", "Unités", parent, "CA", "Unités retournées", ...finHead],
      rows: p.rows.map((r) => [r.name, r.variant ?? "", r.category ?? "", r.units, r.orders, r.revenue, r.returnedUnits, ...fin(r)]),
    },
    {
      heading: `${heading} — par catégorie`,
      headers: ["Catégorie", "Unités", parent, "CA", "Unités retournées", ...finHead],
      rows: p.categories.map((r) => [r.name, r.units, r.orders, r.revenue, r.returnedUnits, ...fin(r)]),
    },
  ];
}

export async function GET(request: Request, routeCtx: { params: Promise<{ type: string }> }): Promise<Response> {
  const user = await requirePermission("analytics.view");
  const { type } = await routeCtx.params;
  const access = analyticsAccess(user);
  const allowed = TYPES[type];
  if (!allowed) return new Response("Not found", { status: 404 });
  if (!allowed(access)) return new Response("Forbidden", { status: 403 });

  const url = new URL(request.url);
  const { period, filters } = contextFor(user, access, Object.fromEntries(url.searchParams.entries()));
  const business = await getReportBusinessInfo();
  const meta = [`Période : ${period.label}`, `Généré le : ${new Date().toLocaleString("fr-FR")}`, "Définitions : voir la section « Définitions des indicateurs » de la page"];
  const send = (name: string, title: string, sections: CsvSection[]) =>
    csvDocumentResponse(`analyses-${name}`, csvDocument({ title: `${business.companyName} — ${title}`, meta, sections }));

  switch (type) {
    case "revenus": {
      const [o, series] = await Promise.all([getOnlineOverview(period.range, filters), getOnlineRevenueSeries(period, filters)]);
      return send("revenus", "Chiffre d'affaires en ligne", [
        {
          heading: "Résumé (commandes passées sur la période)",
          headers: ["Indicateur", "Valeur"],
          rows: [
            ["Commandes", o.orders],
            ["Confirmées", o.confirmed],
            ["Taux de confirmation (%)", pct(o.confirmationRate)],
            ["Expédiées", o.shipped],
            ["Livrées", o.delivered],
            ["Taux de livraison (%)", pct(o.deliveryRate)],
            ["Annulées", o.cancelled],
            ["Échecs", o.failed],
            ["Retournées", o.returned],
            ["CA commandé", o.placedRevenue],
            ["CA livré", o.deliveredRevenue],
            ["Panier moyen", o.averageOrderValue ?? ""],
            ["Unités vendues", o.unitsSold],
            ["Valeur retournée", o.returnedValue],
            ["Remboursé", o.refundedAmount],
          ],
        },
        { heading: "Par jour / mois (date de commande)", headers: ["Période", "Commandes", "CA commandé", "CA livré"], rows: series.map((s) => [s.key, s.orders, s.revenue, s.deliveredRevenue]) },
      ]);
    }
    case "confirmation": {
      const c = await getConfirmationAnalytics(period, filters);
      return send("confirmation", "Confirmation", [
        {
          heading: "Résumé",
          headers: ["Indicateur", "Valeur"],
          rows: [
            ["Entrées (commandes passées)", c.entered],
            ["Confirmées", c.confirmed],
            ["Encore à confirmer", c.pending],
            ["Annulées avant confirmation", c.cancelledBeforeConfirmation],
            ["Taux de confirmation (%)", pct(c.confirmationRate)],
            ["Tentatives", c.attempts],
            ["Délai moyen de confirmation (h)", hours(c.confirmationTime.avgHours)],
            ["Délai médian de confirmation (h)", hours(c.confirmationTime.medianHours)],
            ["Échantillon du délai (commandes)", c.confirmationTime.sample],
            ["Confirmées sans confirmateur enregistré", filters.confirmerId ? "" : c.confirmedWithoutConfirmer],
          ],
        },
        {
          heading: "Par confirmateur (utilisateur ayant enregistré la tentative)",
          headers: ["Confirmateur", "Actif", "Tentatives", "Confirmations", "Annulations", "Délai moyen (h)", "Échantillon"],
          rows: c.byConfirmer.map((r) => [r.name, r.active ? "oui" : "non", r.attempts, r.confirmations, r.cancellations, hours(r.avgConfirmationHours), r.sample]),
        },
        { heading: "Résultats des tentatives", headers: ["Résultat", "Tentatives"], rows: c.outcomes.map((o) => [CONFIRMATION_OUTCOME_LABELS[o.outcome] ?? o.outcome, o.count]) },
        { heading: "Par origine", headers: ["Origine", "Entrées", "Confirmées", "Taux (%)"], rows: c.bySource.map((s) => [s.label, s.entered, s.confirmed, pct(s.rate)]) },
        { heading: "Par jour / mois", headers: ["Période", "Entrées", "Confirmées", "Tentatives"], rows: c.series.map((s) => [s.key, s.entered, s.confirmed, s.attempts]) },
      ]);
    }
    case "livraison": {
      const d = await getDeliveryAnalytics(period, filters);
      const row = (r: typeof d.overall) => [r.label, r.shipped, r.delivered, r.failed, r.returned, r.inProgress, pct(r.deliveryRate), pct(r.failureRate), pct(r.returnRate), hours(r.shippedToDelivered.avgHours)];
      const headers = ["", "Expédiées", "Livrées", "Échecs", "Retournées", "En cours", "Taux de livraison (%)", "Taux d'échec (%)", "Taux de retour (%)", "Expédiée → livrée (h)"];
      return send("livraison", "Livraison (commandes expédiées sur la période)", [
        { heading: "Global", headers, rows: [row(d.overall)] },
        {
          heading: "Délais moyens (h)",
          headers: ["Délai", "Moyenne (h)", "Médiane (h)", "Échantillon"],
          rows: [
            ["Confirmée → expédiée", hours(d.confirmedToShipped.avgHours), hours(d.confirmedToShipped.medianHours), d.confirmedToShipped.sample],
            ["Expédiée → livrée", hours(d.shippedToDelivered.avgHours), hours(d.shippedToDelivered.medianHours), d.shippedToDelivered.sample],
            ["Confirmée → livrée", hours(d.confirmedToDelivered.avgHours), hours(d.confirmedToDelivered.medianHours), d.confirmedToDelivered.sample],
          ],
        },
        { heading: "Par transporteur", headers: ["Transporteur", ...headers.slice(1)], rows: d.byProvider.map(row) },
        { heading: "Par origine", headers: ["Origine", ...headers.slice(1)], rows: d.bySource.map(row) },
      ]);
    }
    case "produits": {
      const withFinance = access.finance;
      const [online, store] = await Promise.all([
        access.online ? getOnlineProductPerformance(period.range, filters, { withFinance }) : null,
        access.store ? getStoreProductPerformance(user, period.range, filters, { withFinance }) : null,
      ]);
      return send("produits", "Performance produits", [
        ...(online ? productSection("En ligne", "Commandes", online, withFinance) : []),
        ...(store ? productSection("Magasin", "Ventes", store, withFinance) : []),
      ]);
    }
    case "commissions": {
      const c = await getCommissionAnalytics(period, filters);
      return send("commissions", "Commissions (écritures datées de la période)", [
        { heading: "Résumé", headers: ["Gagnées", "Écritures gagnées", "Annulées", "Écritures annulées", "Nettes"], rows: [[c.earned, c.earnedCount, c.reversed, c.reversedCount, c.net]] },
        { heading: "Par agent", headers: ["Agent", "Actif", "Gagnées", "Écritures", "Annulées", "Écritures", "Nettes"], rows: c.byAgent.map((r) => [r.name, r.active ? "oui" : "non", r.earned, r.earnedCount, r.reversed, r.reversedCount, r.net]) },
        { heading: "Par jour / mois", headers: ["Période", "Gagnées", "Annulées", "Nettes"], rows: c.series.map((s) => [s.key, s.earned, s.reversed, s.net]) },
      ]);
    }
    case "canaux": {
      const [funnel, store] = await Promise.all([access.online ? getOnlineSourceFunnel(period.range, filters) : null, access.store ? getStoreOverview(user, period, filters) : null]);
      const sections: CsvSection[] = [];
      if (funnel)
        sections.push({
          heading: "En ligne — entonnoir par origine (commandes passées)",
          headers: ["Origine", "Commandes", "Confirmées", "Expédiées", "Livrées", "Retournées", "Annulées", "Échecs", "Taux conf. (%)", "Taux livr. (%)", "CA commandé"],
          rows: funnel.map((r) => [sourceLabel(r.key), r.orders, r.confirmed, r.shipped, r.delivered, r.returned, r.cancelled, r.failed, pct(r.confirmationRate), pct(r.deliveryRate), r.revenue]),
        });
      if (store) {
        sections.push({ heading: "Magasin — résumé", headers: ["Ventes", "Unités", "CA brut", "Remboursements", "CA net"], rows: [[store.report.salesCount, store.report.unitsSold, store.report.grossSales, store.report.refunds, store.report.netSales]] });
        sections.push({ heading: "Magasin — par magasin", headers: ["Magasin", "Ventes", "CA brut"], rows: store.report.byChannel.map((c) => [c.name, c.count, c.gross]) });
        sections.push({ heading: "Magasin — par emplacement", headers: ["Emplacement", "Ventes", "CA brut"], rows: store.report.byLocation.map((w) => [w.name, w.count, w.gross]) });
      }
      return send("canaux", "Origines & magasins", sections);
    }
  }
  return new Response("Not found", { status: 404 });
}
