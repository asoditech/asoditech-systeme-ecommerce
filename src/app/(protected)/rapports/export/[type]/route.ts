import { requirePermission } from "@/lib/auth/guards";
import { resolveReportRange } from "@/lib/reports/range";
import { csvResponse } from "@/lib/reports/csv";
import { getSalesReport } from "@/lib/queries/reports/sales";
import { getProductProfitReport } from "@/lib/queries/reports/product-profit";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { getDeliveryPerformanceReport } from "@/lib/queries/reports/delivery";
import { getCustomerReport } from "@/lib/queries/reports/customers";
import { getCashflowReport } from "@/lib/queries/reports/cashflow";

/**
 * One CSV export endpoint for every /rapports page — `/rapports/export/<type>`
 * with the same `period` / `from` / `to` query params the page uses, so a
 * download always matches what's on screen. `analytics.view`-gated like
 * the pages themselves; tenant scoping is automatic (the queries all go
 * through the tenant-scoped `prisma`).
 */

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

  switch (type) {
    case "ventes": {
      const r = await getSalesReport(resolved.range, resolved.previous);
      return csvResponse(
        `rapport-ventes-${stamp}`,
        ["Date", "Commandes", "CA"],
        r.daily.map((d) => [d.date, d.orders, d.revenue])
      );
    }
    case "rentabilite": {
      const r = await getProductProfitReport(resolved.range);
      return csvResponse(
        `rapport-rentabilite-${stamp}`,
        ["Produit", "Unités vendues", "CA", "Coût marchandises", "Marge brute", "Marge %", "Lignes sans coût"],
        r.products.map((p) => [p.name, p.unitsSold, p.revenue, p.cogs, p.grossProfit, p.marginPct, p.linesMissingCost])
      );
    }
    case "stock": {
      const warehouseId = url.searchParams.get("warehouseId") ?? undefined;
      const r = await getStockValuationReport({ warehouseId });
      return csvResponse(
        `rapport-stock-${new Date().toLocaleDateString("en-CA")}`,
        ["Entrepôt", "Produit", "Variante", "SKU", "Qté", "Coût unitaire", "PV unitaire", "Valeur au coût", "Valeur au PV", `Unités vendues (${r.dormantDays} j)`, "Dormant"],
        r.rows.map((row) => [
          row.warehouseName, row.productName, row.variantLabel ?? "", row.sku, row.quantityOnHand,
          row.unitCost, row.unitRetail, row.valueAtCost, row.valueAtRetail, row.unitsSoldInWindow, row.dormant ? "oui" : "non",
        ])
      );
    }
    case "livraison": {
      const r = await getDeliveryPerformanceReport(resolved.range);
      const header = ["Dimension", "Clé", "Total", "Livrées", "Échecs", "Retours", "En transit", "Taux livraison %", "Délai moyen (j)", "Coût livraison", "COD encaissé", "COD en attente"];
      const line = (dim: string, x: (typeof r.byProvider)[number]) => [
        dim, x.key, x.total, x.delivered, x.failed, x.returned, x.inTransit, x.successRate, x.avgDeliveryDays, x.shippingCost, x.codCollected, x.codPending,
      ];
      return csvResponse(`rapport-livraison-${stamp}`, header, [
        line("Global", r.overall),
        ...r.byProvider.map((x) => line("Transporteur", x)),
        ...r.byCity.map((x) => line("Ville", x)),
      ]);
    }
    case "clients": {
      const r = await getCustomerReport(resolved.range);
      return csvResponse(
        `rapport-clients-${stamp}`,
        ["Client", "Ville", "Commandes", "CA", "Première commande", "Nouveau"],
        r.topCustomers.map((c) => [c.name, c.city ?? "", c.orders, c.revenue, c.firstOrderAt, c.isNew ? "oui" : "non"])
      );
    }
    case "tresorerie": {
      const r = await getCashflowReport(resolved.range);
      const rows: (string | number | null)[][] = [
        ["Encaissé", "", r.inflows.collected],
        ["À encaisser", "", r.inflows.pending],
        ["Remboursé", "", -r.inflows.refunded],
        ...r.inflows.byMethod.map((m) => [`  ${m.method} (encaissé)`, "", m.collected] as (string | number | null)[]),
        ...r.outflows.expensesByCategory.map((e) => [`Dépense — ${e.category}`, "", -e.amount] as (string | number | null)[]),
        ["Frais de livraison", "", -r.outflows.deliveryCost],
        ["Trésorerie nette (encaissé − sorties)", "", r.netCash],
        ["Trésorerie nette projetée", "", r.projectedNet],
      ];
      return csvResponse(`rapport-tresorerie-${stamp}`, ["Poste", "", "Montant"], rows);
    }
    default:
      return new Response("Rapport inconnu", { status: 404 });
  }
}
