import Link from "next/link";
import { Receipt, ReceiptText, Truck, Wallet } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { ExpenseForm } from "@/components/finance/expense-form";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  type PeriodRange,
} from "@/lib/queries/finance";
import { formatCurrency, formatDate } from "@/lib/format";

export const metadata = { title: "Dépenses & charges — ASODITECH Gestion E-commerce" };

const PERIODS = [
  { key: "mois", label: "Ce mois", range: currentMonthRange },
  { key: "trimestre", label: "Ce trimestre", range: currentQuarterRange },
  { key: "annee", label: "Cette année", range: currentYearRange },
] as const;

export default async function DepensesPage({
  searchParams,
}: {
  searchParams: Promise<{ periode?: string; categoryId?: string; dateFrom?: string; dateTo?: string; page?: string }>;
}) {
  const user = await requirePermission("finance.view");
  const params = await searchParams;
  const canManage = hasPermission(user.role, "finance.manage");
  const page = Number(params.page) || 1;

  const periodEntry = PERIODS.find((p) => p.key === params.periode) ?? PERIODS[0];
  const period: PeriodRange = periodEntry.range();

  const categories = await listExpenseCategories();
  const categoryFilter = categories.find((c) => c.id === params.categoryId)?.id;

  const [summary, { expenses, total, pageSize }] = await Promise.all([
    getFinanceSummary(period),
    listExpenses({
      categoryId: categoryFilter,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      page,
    }),
  ]);

  const hasActiveFilter = Boolean(categoryFilter || params.dateFrom || params.dateTo);

  return (
    <div>
      <PageHeader
        title="Dépenses & charges"
        description="Toutes les charges de l'entreprise : dépenses enregistrées et coût de livraison."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1">
              {PERIODS.map((p) => (
                <Button
                  key={p.key}
                  size="sm"
                  variant={p.key === periodEntry.key ? "default" : "outline"}
                  render={<Link href={p.key === "mois" ? "/depenses" : `/depenses?periode=${p.key}`} />}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            {canManage && <ExpenseForm categories={categories} />}
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label={`Total des charges (${periodEntry.label.replace("Ce ", "").replace("Cette ", "")})`}
          value={formatCurrency(summary.chargesTotal)}
          hint="Dépenses enregistrées + coût de livraison"
          icon={Wallet}
          tone="danger"
        />
        <KpiCard
          label="Dépenses enregistrées"
          value={formatCurrency(summary.expensesTotal)}
          icon={ReceiptText}
          tone="warning"
        />
        <KpiCard label="Coût de livraison" value={formatCurrency(summary.deliveryCostTotal)} icon={Truck} tone="info" />
      </div>

      <form className="mb-4 flex flex-wrap gap-2" action="/depenses">
        {params.periode ? <input type="hidden" name="periode" value={params.periode} /> : null}
        <Select name="categoryId" defaultValue={categoryFilter ?? "all"}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Catégorie">
              {categoryFilter
                ? (categories.find((c) => c.id === categoryFilter)?.name ?? "Catégorie")
                : "Toutes les catégories"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes les catégories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" name="dateFrom" defaultValue={params.dateFrom} className="w-40" />
        <Input type="date" name="dateTo" defaultValue={params.dateTo} className="w-40" />
        <Button type="submit" variant="outline">
          Filtrer
        </Button>
        {hasActiveFilter ? (
          <Button
            variant="ghost"
            render={<Link href={params.periode ? `/depenses?periode=${params.periode}` : "/depenses"} />}
          >
            Réinitialiser
          </Button>
        ) : null}
      </form>

      {expenses.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title={hasActiveFilter ? "Aucune dépense ne correspond à ces critères." : "Aucune dépense enregistrée."}
          description={
            hasActiveFilter
              ? undefined
              : "Les catégories de dépenses sont configurables — enregistrez votre première charge."
          }
          action={!hasActiveFilter && canManage ? <ExpenseForm categories={categories} /> : undefined}
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
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/depenses"
            searchParams={{
              periode: params.periode,
              categoryId: categoryFilter,
              dateFrom: params.dateFrom,
              dateTo: params.dateTo,
            }}
          />
        </div>
      )}
    </div>
  );
}
