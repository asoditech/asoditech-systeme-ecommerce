import Link from "next/link";
import { Receipt, Wallet, PackageMinus, TrendingUp, ReceiptText, Truck, TrendingDown, Megaphone, Percent } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { ExpenseForm } from "@/components/finance/expense-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getFinanceSummary,
  listExpenses,
  listExpenseCategories,
  currentMonthRange,
  currentQuarterRange,
  currentYearRange,
  previousPeriodOfSameLength,
  type PeriodRange,
} from "@/lib/queries/finance";
import { computeProductProfitability } from "@/lib/profitability";
import { formatCurrency, formatDate } from "@/lib/format";

export const metadata = { title: "Finance — ASODITECH Gestion E-commerce" };

function parseDate(value: string | undefined, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  const d = new Date(endOfDay ? `${value}T23:59:59` : `${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function resolvePeriod(params: { period?: string; from?: string; to?: string }): {
  range: PeriodRange;
  key: string;
  label: string;
} {
  const from = parseDate(params.from);
  const to = parseDate(params.to, true);
  if (from && to) return { range: { from, to }, key: "custom", label: `${params.from} → ${params.to}` };
  if (params.period === "quarter") return { range: currentQuarterRange(), key: "quarter", label: "Ce trimestre" };
  if (params.period === "year") return { range: currentYearRange(), key: "year", label: "Cette année" };
  return { range: currentMonthRange(), key: "month", label: "Ce mois" };
}

function pctLabel(pct: number | null): string | undefined {
  return pct === null ? undefined : `Marge ${pct.toFixed(1)} %`;
}

function trendLabel(current: number, previous: number): { direction: "up" | "down" | "flat"; label: string } | undefined {
  if (previous === 0) return undefined;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return {
    direction: change > 0.5 ? "up" : change < -0.5 ? "down" : "flat",
    label: `${change > 0 ? "+" : ""}${change.toFixed(1)}% vs période précédente`,
  };
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requirePermission("finance.view");
  const params = await searchParams;
  const { range: period, key: periodKey, label: periodLabel } = resolvePeriod(params);
  const previousPeriod = previousPeriodOfSameLength(period);
  const canManage = hasPermission(user.role, "finance.manage");

  const [summary, previousSummary, productProfit, { expenses }, categories] = await Promise.all([
    getFinanceSummary(period),
    getFinanceSummary(previousPeriod),
    computeProductProfitability(period, { limit: 15 }),
    listExpenses({}),
    listExpenseCategories(),
  ]);

  return (
    <div>
      <PageHeader
        title="Finance"
        description="Revenus, coûts, dépenses et rentabilité réelle."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: "month", label: "Ce mois" },
              { key: "quarter", label: "Ce trimestre" },
              { key: "year", label: "Cette année" },
            ].map((p) => (
              <Button
                key={p.key}
                variant={periodKey === p.key ? "default" : "outline"}
                size="sm"
                render={<Link href={`/finance?period=${p.key}`} />}
              >
                {p.label}
              </Button>
            ))}
            <form action="/finance" className="flex items-center gap-1.5">
              <Input type="date" name="from" defaultValue={params.from} className="h-8 w-36" aria-label="Du" />
              <Input type="date" name="to" defaultValue={params.to} className="h-8 w-36" aria-label="Au" />
              <Button type="submit" variant={periodKey === "custom" ? "default" : "outline"} size="sm">
                OK
              </Button>
            </form>
          </div>
        }
      />

      <p className="mb-4 text-sm text-muted-foreground">
        Période : <span className="text-foreground">{periodLabel}</span>
        {summary.itemsMissingCost > 0 && (
          <span className="ml-2 text-amber-600 dark:text-amber-400">
            — {summary.itemsMissingCost} article(s) vendu(s) sans coût d&apos;achat renseigné : le bénéfice est incomplet.
          </span>
        )}
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Chiffre d'affaires"
          value={formatCurrency(summary.revenue)}
          hint={summary.refundsTotal > 0 ? `Net de ${formatCurrency(summary.refundsTotal)} de remboursements` : undefined}
          trend={trendLabel(summary.revenue, previousSummary.revenue)}
          icon={Wallet}
          tone="primary"
        />
        <KpiCard
          label="Coût des marchandises vendues"
          value={summary.cogsComplete ? formatCurrency(summary.cogs!) : null}
          unavailableReason="Non calculable"
          hint={!summary.cogsComplete ? "Coût d'achat manquant sur certains articles" : undefined}
          icon={PackageMinus}
          tone="warning"
        />
        <KpiCard
          label="Bénéfice brut"
          value={summary.grossProfit !== null ? formatCurrency(summary.grossProfit) : null}
          unavailableReason="Non calculable"
          hint={pctLabel(summary.grossMarginPct)}
          icon={TrendingUp}
          tone="success"
        />
        <KpiCard label="Coût de livraison" value={formatCurrency(summary.deliveryCostTotal)} icon={Truck} tone="info" />
        <KpiCard
          label="Publicité"
          value={formatCurrency(summary.advertisingCost)}
          hint={summary.otherExpensesTotal > 0 ? `+ ${formatCurrency(summary.otherExpensesTotal)} autres dépenses` : undefined}
          icon={Megaphone}
          tone="danger"
        />
        <KpiCard label="Dépenses totales" value={formatCurrency(summary.expensesTotal)} icon={ReceiptText} tone="danger" />
        <KpiCard
          label="Bénéfice net"
          value={summary.netProfit !== null ? formatCurrency(summary.netProfit) : null}
          unavailableReason="Non calculable"
          hint={pctLabel(summary.netMarginPct) ?? (summary.netProfit !== null ? "Après COGS, livraison et dépenses" : undefined)}
          tone="violet"
          trend={
            summary.netProfit !== null && previousSummary.netProfit !== null
              ? trendLabel(summary.netProfit, previousSummary.netProfit)
              : undefined
          }
          icon={TrendingDown}
        />
        <KpiCard
          label="Panier moyen"
          value={summary.avgOrderValue !== null ? formatCurrency(summary.avgOrderValue) : null}
          unavailableReason="Aucune commande"
          hint={`${summary.ordersCount} commande(s)`}
          icon={Percent}
          tone="info"
        />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-[15px]">Rentabilité par produit</CardTitle>
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
                    <TableHead className="text-right">Coût</TableHead>
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
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {p.cogs === null ? "—" : formatCurrency(String(p.cogs))}
                      </TableCell>
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

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Dépenses récentes</h2>
        {canManage && <ExpenseForm categories={categories} />}
      </div>

      {expenses.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="Aucune dépense enregistrée."
          description="Les dépenses sont des catégories configurables — ajoutez-en une pour commencer."
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Catégorie</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Fournisseur</TableHead>
                <TableHead>Montant</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">{e.category.name}</TableCell>
                  <TableCell className="text-muted-foreground">{e.description ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{e.vendor ?? "—"}</TableCell>
                  <TableCell>{formatCurrency(e.amount.toString(), e.currency)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(e.date)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
