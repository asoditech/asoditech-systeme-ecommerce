import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange } from "@/lib/reports/range";
import { csvDocument, csvDocumentResponse, type CsvSection } from "@/lib/reports/csv";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { getSalesReport } from "@/lib/queries/reports/sales";
import { getProductProfitReport } from "@/lib/queries/reports/product-profit";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { getDeliveryPerformanceReport } from "@/lib/queries/reports/delivery";
import { getCustomerReport } from "@/lib/queries/reports/customers";
import { getCashflowReport } from "@/lib/queries/reports/cashflow";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

/**
 * One CSV export endpoint for every /rapports page — `/rapports/export/<type>`
 * with the same `period` / `from` / `to` query params the page uses, so a
 * download always matches what's on screen. Each export is a structured
 * multi-section document (`csvDocument`): a title + period block, then a
 * labelled résumé, then the breakdown tables. `analytics.view`-gated;
 * tenant scoping is automatic (queries go through the tenant-scoped `prisma`).
 */

const fmtPct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} %`);
const label = (map: Record<string, { label: string }>, key: string) => map[key]?.label ?? key;

export async function GET(request: Request, ctx: { params: Promise<{ type: string }> }): Promise<Response> {
  await requirePermission("analytics.view");
  const { type } = await ctx.params;
  const url = new URL(request.url);
  const params = {
    period: url.searchParams.get("period") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };
  const resolved = resolveReportRange(params);
  const stamp = resolved.key === "custom" ? `${params.from}_${params.to}` : resolved.key;
  const business = await getReportBusinessInfo();
  const generatedAt = new Date().toLocaleString("fr-FR");

  const doc = (title: string, sections: CsvSection[], extraMeta: string[] = []) =>
    csvDocument({
      title: `${business.companyName} — ${title}`,
      meta: [`Période : ${resolved.label}`, `Généré le : ${generatedAt}`, ...extraMeta],
      sections,
    });

  switch (type) {
    case "ventes": {
      const r = await getSalesReport(resolved.range, resolved.previous);
      const kpi = (name: string, cur: string, prev: string, delta: number | null): (string | number | null)[] => [
        name,
        cur,
        prev,
        delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta} %`,
      ];
      return csvDocumentResponse(
        `rapport-ventes-${stamp}`,
        doc("Rapport de ventes", [
          {
            heading: "Résumé",
            headers: ["Indicateur", "Période", "Période précédente", "Évolution"],
            rows: [
              kpi("Chiffre d'affaires", String(r.current.revenue), String(r.previous.revenue), r.deltas.revenue),
              kpi("Commandes", String(r.current.ordersCount), String(r.previous.ordersCount), r.deltas.ordersCount),
              kpi("Panier moyen", String(r.current.avgOrderValue ?? "—"), String(r.previous.avgOrderValue ?? "—"), r.deltas.avgOrderValue),
              kpi("Articles vendus", String(r.current.unitsSold), String(r.previous.unitsSold), r.deltas.unitsSold),
              kpi("Taux de confirmation", fmtPct(r.current.confirmationRate), fmtPct(r.previous.confirmationRate), r.deltas.confirmationRate),
              kpi("Taux de livraison", fmtPct(r.current.deliveryRate), fmtPct(r.previous.deliveryRate), r.deltas.deliveryRate),
              kpi("Taux de retour", fmtPct(r.current.returnRate), fmtPct(r.previous.returnRate), r.deltas.returnRate),
            ],
          },
          {
            heading: "Par statut de commande",
            headers: ["Statut", "Commandes", "Montant"],
            rows: r.byStatus.map((s) => [label(ORDER_STATUS_LABELS, s.status), s.count, s.revenue]),
          },
          {
            heading: "Par canal",
            headers: ["Canal", "Commandes", "CA"],
            rows: r.byChannel.map((s) => [s.channel, s.count, s.revenue]),
          },
          {
            heading: r.granularity === "month" ? "Évolution par mois" : "Évolution par jour",
            headers: [r.granularity === "month" ? "Mois" : "Jour", "Commandes", "CA"],
            rows: r.series.map((p) => [p.label, p.orders, p.revenue]),
          },
        ])
      );
    }

    case "rentabilite": {
      const r = await getProductProfitReport(resolved.range);
      const profitRows = (rows: typeof r.products) =>
        rows.map((p) => [p.name, p.unitsSold, p.revenue, p.cogs ?? "—", p.grossProfit ?? "—", fmtPct(p.marginPct), p.linesMissingCost]);
      return csvDocumentResponse(
        `rapport-rentabilite-${stamp}`,
        doc("Rapport de rentabilité", [
          {
            heading: "Total",
            headers: ["CA", "Coût des marchandises", "Marge brute", "Marge %"],
            rows: [[r.totals.revenue, r.totals.cogs ?? "—", r.totals.grossProfit ?? "—", fmtPct(r.totals.marginPct)]],
          },
          {
            heading: "Par catégorie",
            headers: ["Catégorie", "Unités", "CA", "Coût march.", "Marge brute", "Marge %", "Lignes sans coût"],
            rows: profitRows(r.categories),
          },
          {
            heading: "Par produit",
            headers: ["Produit", "Unités", "CA", "Coût march.", "Marge brute", "Marge %", "Lignes sans coût"],
            rows: profitRows(r.products),
          },
        ])
      );
    }

    case "stock": {
      const warehouseId = url.searchParams.get("warehouseId") ?? undefined;
      const r = await getStockValuationReport({ warehouseId });
      return csvDocumentResponse(
        `rapport-stock-${new Date().toLocaleDateString("en-CA")}`,
        csvDocument({
          title: `${business.companyName} — Valorisation du stock`,
          meta: [`Photo au : ${generatedAt}`, `Fenêtre d'inactivité : ${r.dormantDays} jours`],
          sections: [
            {
              heading: "Total",
              headers: ["Références", "Unités", "Valeur au coût", "Valeur au PV", "Marge potentielle", "Articles dormants", "Articles sans coût"],
              rows: [[
                r.totals.skuCount, r.totals.unitsOnHand, r.totals.valueAtCost ?? "—",
                r.totals.valueAtRetail, r.totals.potentialMargin ?? "—", r.totals.dormantSkuCount, r.totals.linesMissingCost,
              ]],
            },
            {
              heading: "Détail par article",
              headers: ["Entrepôt", "Produit", "Variante", "SKU", "Qté", "Coût unitaire", "PV unitaire", "Valeur au coût", "Valeur au PV", `Unités vendues (${r.dormantDays} j)`, "Dormant"],
              rows: r.rows.map((row) => [
                row.warehouseName, row.productName, row.variantLabel ?? "", row.sku, row.quantityOnHand,
                row.unitCost ?? "—", row.unitRetail, row.valueAtCost ?? "—", row.valueAtRetail, row.unitsSoldInWindow, row.dormant ? "oui" : "non",
              ]),
            },
          ],
        })
      );
    }

    case "livraison": {
      const r = await getDeliveryPerformanceReport(resolved.range);
      const perfHeaders = ["Clé", "Expéditions", "Livrées", "Échecs", "Retours", "En transit", "Taux livraison", "Délai moyen (j)", "Coût total", "Coût livraisons", "Coût retours", "Coût échecs", "COD encaissé", "COD en attente"];
      const perfRow = (x: (typeof r.byProvider)[number]) => [
        x.key, x.total, x.delivered, x.failed, x.returned, x.inTransit, fmtPct(x.successRate),
        x.avgDeliveryDays ?? "—", x.shippingCost, x.deliveryCost, x.returnCost, x.failureCost, x.codCollected, x.codPending,
      ];
      return csvDocumentResponse(
        `rapport-livraison-${stamp}`,
        doc("Rapport de performance livraison", [
          { heading: "Global", headers: perfHeaders, rows: [perfRow(r.overall)] },
          { heading: "Par transporteur", headers: perfHeaders, rows: r.byProvider.map(perfRow) },
          { heading: "Par ville", headers: perfHeaders, rows: r.byCity.map(perfRow) },
        ])
      );
    }

    case "clients": {
      const r = await getCustomerReport(resolved.range);
      return csvDocumentResponse(
        `rapport-clients-${stamp}`,
        doc("Rapport clients", [
          {
            heading: "Résumé",
            headers: ["Indicateur", "Valeur"],
            rows: [
              ["Clients acheteurs", r.totals.distinctBuyers],
              ["Nouveaux clients", r.totals.newCustomers],
              ["Clients récurrents", r.totals.returningCustomers],
              ["Taux de réachat", fmtPct(r.totals.repeatRatePct)],
              ["CA des nouveaux", r.totals.revenueFromNew],
              ["CA des récurrents", r.totals.revenueFromReturning],
              ["Commandes / client", r.totals.avgOrdersPerBuyer ?? "—"],
              ["CA / client", r.totals.avgRevenuePerBuyer ?? "—"],
            ],
          },
          {
            heading: "Meilleurs clients",
            headers: ["Client", "Ville", "Commandes", "CA", "Première commande", "Nouveau"],
            rows: r.topCustomers.map((c) => [c.name, c.city ?? "", c.orders, c.revenue, c.firstOrderAt, c.isNew ? "oui" : "non"]),
          },
          {
            heading: "Par ville",
            headers: ["Ville", "Acheteurs", "Commandes", "CA"],
            rows: r.byCity.map((c) => [c.city, c.buyers, c.orders, c.revenue]),
          },
        ])
      );
    }

    case "tresorerie": {
      const r = await getCashflowReport(resolved.range);
      return csvDocumentResponse(
        `rapport-tresorerie-${stamp}`,
        doc("Rapport de trésorerie", [
          {
            heading: "Synthèse",
            headers: ["Poste", "Montant"],
            rows: [
              ["Encaissé", r.inflows.collected],
              ["À encaisser", r.inflows.pending],
              ["Remboursé", -r.inflows.refunded],
              ["Total des sorties", -r.outflows.total],
              ["Trésorerie nette", r.netCash],
              ["Trésorerie nette projetée", r.projectedNet],
            ],
          },
          {
            heading: "Encaissements par mode de paiement",
            headers: ["Mode", "Encaissé", "À encaisser"],
            rows: r.inflows.byMethod.map((m) => [m.method, m.collected, m.pending]),
          },
          {
            heading: "Sorties par poste",
            headers: ["Poste", "Montant"],
            rows: [
              ...r.outflows.expensesByCategory.map((e) => [e.category, -e.amount] as (string | number)[]),
              ["Frais de livraison", -r.outflows.deliveryCost],
            ],
          },
        ])
      );
    }

    default:
      return new Response("Rapport inconnu", { status: 404 });
  }
}
