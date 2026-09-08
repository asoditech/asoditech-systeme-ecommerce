import Link from "next/link";
import { Receipt, ReceiptText, Truck, Wallet } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { ExpenseForm } from "@/components/finance/expense-form";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
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
  type ExpenseSort,
} from "@/lib/queries/finance";
import { formatCurrency, formatDate } from "@/lib/format";

export const metadata = { title: "Dépenses & charges — ASODITECH Gestion E-commerce" };

const PERIODS = [
  { key: "mois", label: "Ce mois", range: currentMonthRange },
  { key: "trimestre", label: "Ce trimestre", range: currentQuarterRange },
  { key: "annee", label: "Cette année", range: currentYearRange },
] as const;

const SORT_LABELS: Record<ExpenseSort, string> = {
  recent: "Plus récentes",
  "amount-desc": "Montant décroissant",
  "amount-asc": "Montant croissant",
};

export default async function DepensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    periode?: string;
    q?: string;
    categoryId?: string;
    dateFrom?: string;
    dateTo?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("finance.view");
  const params = await searchParams;
  const canManage = hasPermission(user.role, "finance.manage");
  const page = Number(params.page) || 1;

  const periodEntry = PERIODS.find((p) => p.key === params.periode) ?? PERIODS[0];
  const period: PeriodRange = periodEntry.range();

  const categories = await listExpenseCategories();
  const categoryFilter = categories.find((c) => c.id === params.categoryId)?.id;
  const sortFilter: ExpenseSort =
    params.sort === "amount-desc" || params.sort === "amount-asc" ? params.sort : "recent";

  const now = new Date();
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA");
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toLocaleDateString("en-CA");
  const isThisMonth = params.dateFrom === monthFrom && params.dateTo === monthTo;

  const [summary, { expenses, total, pageSize }] = await Promise.all([
    getFinanceSummary(period),
    listExpenses({
      q: params.q,
      categoryId: categoryFilter,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      sort: sortFilter,
      page,
    }),
  ]);

  const hasActiveFilter = Boolean(params.q || categoryFilter || params.dateFrom || params.dateTo || params.sort);
  const periodSuffix = params.periode ? `?periode=${params.periode}` : "";

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

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSearchInput placeholder="Description ou fournisseur..." defaultValue={params.q} className="w-56" />
        <FilterSelect
          paramKey="categoryId"
          value={categoryFilter}
          allLabel="Toutes les catégories"
          ariaLabel="Catégorie"
          className="w-52"
          options={categories.map((c) => ({ value: c.id, label: c.name }))}
        />
        <FilterSelect
          paramKey="sort"
          value={params.sort === "amount-desc" || params.sort === "amount-asc" ? params.sort : undefined}
          allLabel={SORT_LABELS.recent}
          ariaLabel="Trier"
          className="w-48"
          options={[
            { value: "amount-desc", label: SORT_LABELS["amount-desc"] },
            { value: "amount-asc", label: SORT_LABELS["amount-asc"] },
          ]}
        />
        <form className="flex items-center gap-2" action="/depenses">
          {params.periode ? <input type="hidden" name="periode" value={params.periode} /> : null}
          {params.q ? <input type="hidden" name="q" value={params.q} /> : null}
          {categoryFilter ? <input type="hidden" name="categoryId" value={categoryFilter} /> : null}
          {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
          <Input type="date" name="dateFrom" defaultValue={params.dateFrom} className="w-40" aria-label="Date de début" />
          <Input type="date" name="dateTo" defaultValue={params.dateTo} className="w-40" aria-label="Date de fin" />
          <Button type="submit" size="sm" variant="outline">
            Filtrer
          </Button>
        </form>
        <Button
          size="sm"
          variant={isThisMonth ? "default" : "ghost"}
          render={<Link href={`/depenses${periodSuffix}${periodSuffix ? "&" : "?"}dateFrom=${monthFrom}&dateTo=${monthTo}`} />}
        >
          Ce mois-ci
        </Button>
        {hasActiveFilter ? (
          <Button size="sm" variant="ghost" render={<Link href={params.periode ? `/depenses?periode=${params.periode}` : "/depenses"} />}>
            Réinitialiser
          </Button>
        ) : null}
      </div>

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
              q: params.q,
              categoryId: categoryFilter,
              dateFrom: params.dateFrom,
              dateTo: params.dateTo,
              sort: params.sort,
            }}
          />
        </div>
      )}
    </div>
  );
}
