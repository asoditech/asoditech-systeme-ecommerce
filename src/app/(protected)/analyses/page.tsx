import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { RevenueTrendChart } from "@/components/analytics/revenue-trend-chart";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart } from "lucide-react";
import { requirePermission } from "@/lib/auth/guards";
import { getRevenueTrend, getOrderStatusBreakdown, getTopProducts } from "@/lib/queries/analytics";
import { formatCurrency } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Analyses — ASODITECH Gestion E-commerce" };

export default async function AnalysesPage() {
  await requirePermission("analytics.view");

  const [trend, statusBreakdown, topProducts] = await Promise.all([
    getRevenueTrend(30),
    getOrderStatusBreakdown(),
    getTopProducts(5),
  ]);

  const hasAnyOrders = statusBreakdown.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses" description="Tendances de chiffre d'affaires, répartition des commandes et meilleurs produits." />

      {!hasAnyOrders ? (
        <EmptyState
          icon={LineChart}
          title="Pas encore de données à analyser."
          description="Les analyses apparaîtront dès que des commandes seront enregistrées."
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Chiffre d&apos;affaires — 30 derniers jours</CardTitle>
            </CardHeader>
            <CardContent>
              <RevenueTrendChart data={trend} />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Répartition des commandes par statut</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Statut</TableHead>
                      <TableHead>Nombre</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statusBreakdown.map((s) => (
                      <TableRow key={s.status}>
                        <TableCell>
                          <StatusBadge status={s.status} labels={ORDER_STATUS_LABELS} />
                        </TableCell>
                        <TableCell>{s.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Produits les plus vendus</CardTitle>
              </CardHeader>
              <CardContent>
                {topProducts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune vente enregistrée.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Produit</TableHead>
                        <TableHead>Unités vendues</TableHead>
                        <TableHead>Chiffre d&apos;affaires</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {topProducts.map((p, i) => (
                        <TableRow key={p.product?.id ?? i}>
                          <TableCell className="font-medium">{p.product?.name ?? "Produit supprimé"}</TableCell>
                          <TableCell>{p.unitsSold}</TableCell>
                          <TableCell>{formatCurrency(p.revenue.toString())}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
