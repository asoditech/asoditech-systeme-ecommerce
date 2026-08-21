import Link from "next/link";
import { Receipt, Wallet, PackageMinus, TrendingUp, ReceiptText, Truck, TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { ExpenseForm } from "@/components/finance/expense-form";
import { Button } from "@/components/ui/button";
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
import { formatCurrency, formatDate } from "@/lib/format";

export const metadata = { title: "Finance — ASODITECH Gestion E-commerce" };

function getPeriod(key: string | undefined): PeriodRange {
  if (key === "quarter") return currentQuarterRange();
  if (key === "year") return currentYearRange();
  return currentMonthRange();
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
  searchParams: Promise<{ period?: string }>;
}) {
  const user = await requirePermission("finance.view");
  const params = await searchParams;
  const period = getPeriod(params.period);
  const previousPeriod = previousPeriodOfSameLength(period);
  const canManage = hasPermission(user.role, "finance.manage");

  const [summary, previousSummary, { expenses }, categories] = await Promise.all([
    getFinanceSummary(period),
    getFinanceSummary(previousPeriod),
    listExpenses({}),
    listExpenseCategories(),
  ]);

  return (
    <div>
      <PageHeader
        title="Finance"
        description="Revenus, coûts, dépenses et rentabilité."
        actions={
          <div className="flex gap-2">
            {[
              { key: "month", label: "Ce mois" },
              { key: "quarter", label: "Ce trimestre" },
              { key: "year", label: "Cette année" },
            ].map((p) => (
              <Button
                key={p.key}
                variant={(params.period ?? "month") === p.key ? "default" : "outline"}
                size="sm"
                render={<Link href={`/finance?period=${p.key}`} />}
              >
                {p.label}
              </Button>
            ))}
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Chiffre d'affaires"
          value={formatCurrency(summary.revenue)}
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
          icon={TrendingUp}
          tone="success"
        />
        <KpiCard label="Dépenses enregistrées" value={formatCurrency(summary.expensesTotal)} icon={ReceiptText} tone="danger" />
        <KpiCard label="Coût de livraison" value={formatCurrency(summary.deliveryCostTotal)} icon={Truck} tone="info" />
        <KpiCard
          label="Bénéfice net"
          value={summary.netProfit !== null ? formatCurrency(summary.netProfit) : null}
          unavailableReason="Non calculable"
          hint={summary.netProfit !== null ? "Basé sur les dépenses enregistrées" : undefined}
          tone="violet"
          trend={
            summary.netProfit !== null && previousSummary.netProfit !== null
              ? trendLabel(summary.netProfit, previousSummary.netProfit)
              : undefined
          }
          icon={TrendingDown}
        />
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Dépenses récentes</h2>
        {canManage && <ExpenseForm categories={categories} />}
      </div>

      {expenses.length === 0 ? (
        <EmptyState icon={Receipt} title="Aucune dépense enregistrée." description="Les dépenses sont des catégories configurables — ajoutez-en une pour commencer." />
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
