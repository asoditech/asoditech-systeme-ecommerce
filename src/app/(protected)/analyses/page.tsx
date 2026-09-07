import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { RevenueTrendChart } from "@/components/analytics/revenue-trend-chart";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart, Wallet, PackageMinus, TrendingUp, TrendingDown } from "lucide-react";
import { requirePermission } from "@/lib/auth/guards";
import { getRevenueTrend, getOrderStatusBreakdown, getChannelBreakdown, getTopProducts } from "@/lib/queries/analytics";
import { currentMonthRange, currentQuarterRange, currentYearRange, type PeriodRange } from "@/lib/queries/finance";
import { computePeriodProfitability, computeProductProfitability } from "@/lib/profitability";
import { formatCurrency } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Analyses — ASODITECH Gestion E-commerce" };

function resolvePeriod(key: string | undefined): { range: PeriodRange; key: string; label: string } {
  if (key === "quarter") return { range: currentQuarterRange(), key, label: "Ce trimestre" };
  if (key === "year") return { range: currentYearRange(), key, label: "Cette année" };
  return { range: currentMonthRange(), key: "month", label: "Ce mois" };
}

export default async function AnalysesPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  await requirePermission("analytics.view");
  const params = await searchParams;
  const { range: period, key: periodKey, label: periodLabel } = resolvePeriod(params.period);

  const [trend, statusBreakdown, channelBreakdown, topProducts, pnl, productProfit] = await Promise.all([
    getRevenueTrend(30),
    getOrderStatusBreakdown(),
    getChannelBreakdown(),
    getTopProducts(5),
    computePeriodProfitability(period),
    computeProductProfitability(period, { limit: 10 }),
  ]);

  const hasAnyOrders = statusBreakdown.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analyses"
        description="Rentabilité, tendances de chiffre d'affaires et meilleurs produits."
        actions={
          <div className="flex gap-2">
            {[
              { key: "month", label: "Ce mois" },
              { key: "quarter", label: "Ce trimestre" },
              { key: "year", label: "Cette année" },
            ].map((p) => (
              <Button
                key={p.key}
                variant={periodKey === p.key ? "default" : "outline"}
                size="sm"
                render={<Link href={`/analyses?period=${p.key}`} />}
              >
                {p.label}
              </Button>
            ))}
          </div>
        }
      />

      {!hasAnyOrders ? (
        <EmptyState
          icon={LineChart}
          title="Pas encore de données à analyser."
          description="Les analyses apparaîtront dès que des commandes seront enregistrées."
        />
      ) : (
        <>
          <div>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">Rentabilité — {periodLabel}</h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard label="Chiffre d'affaires" value={formatCurrency(pnl.revenue)} icon={Wallet} tone="primary" />
              <KpiCard
                label="Coût des marchandises"
                value={pnl.cogsComplete ? formatCurrency(pnl.cogs!) : null}
                unavailableReason="Coût manquant"
                icon={PackageMinus}
                tone="warning"
              />
              <KpiCard
                label="Bénéfice brut"
                value={pnl.grossProfit !== null ? formatCurrency(pnl.grossProfit) : null}
                unavailableReason="Non calculable"
                hint={pnl.grossMarginPct !== null ? `Marge ${pnl.grossMarginPct.toFixed(1)} %` : undefined}
                icon={TrendingUp}
                tone="success"
              />
              <KpiCard
                label="Bénéfice net"
                value={pnl.netProfit !== null ? formatCurrency(pnl.netProfit) : null}
                unavailableReason="Non calculable"
                hint={pnl.netMarginPct !== null ? `Marge ${pnl.netMarginPct.toFixed(1)} %` : undefined}
                icon={TrendingDown}
                tone="violet"
              />
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Chiffre d&apos;affaires — 30 derniers jours</CardTitle>
            </CardHeader>
            <CardContent>
              <RevenueTrendChart data={trend} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Rentabilité par produit — {periodLabel}</CardTitle>
            </CardHeader>
            <CardContent>
              {productProfit.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune vente sur la période.</p>
              ) : (
                <div className="rounded-lg border">
                  <Table className="text-[13px] [&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Produit</TableHead>
                        <TableHead className="text-right">Unités</TableHead>
                        <TableHead className="text-right">CA</TableHead>
                        <TableHead className="text-right">Bénéfice brut</TableHead>
                        <TableHead className="text-right">Marge</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {productProfit.map((p) => (
                        <TableRow key={p.productId ?? p.name}>
                          <TableCell className="font-medium">
                            {p.productId ? (
                              <Link href={`/produits/${p.productId}`} className="hover:underline">
                                {p.name}
                              </Link>
                            ) : (
                              p.name
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.unitsSold}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatCurrency(String(p.revenue))}</TableCell>
                          <TableCell
                            className={`text-right font-medium tabular-nums ${
                              p.grossProfit !== null && p.grossProfit < 0 ? "text-destructive" : ""
                            }`}
                          >
                            {p.grossProfit === null ? (
                              <span className="text-xs font-normal text-amber-600 dark:text-amber-400">coût manquant</span>
                            ) : (
                              formatCurrency(String(p.grossProfit))
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {p.marginPct === null ? "—" : `${p.marginPct.toFixed(1)} %`}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
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
                <CardTitle>Répartition des commandes par canal</CardTitle>
              </CardHeader>
              <CardContent>
                {channelBreakdown.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Aucune commande enregistrée.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Canal</TableHead>
                        <TableHead>Nombre</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {channelBreakdown.map((c) => (
                        <TableRow key={c.channel}>
                          <TableCell>
                            <Badge variant="secondary">{c.channel}</Badge>
                          </TableCell>
                          <TableCell>{c.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
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
