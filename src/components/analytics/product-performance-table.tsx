import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortHeader } from "@/components/analytics/sort-header";
import { formatCurrency } from "@/lib/format";
import type { CategoryRow, ProductRow } from "@/lib/analytics/queries/products";

const money = (v: number | null | undefined) => (v === null || v === undefined ? "coût manquant" : formatCurrency(v));

/**
 * Factual product table (units, orders, revenue, returns). The finance
 * columns render only when the rows CARRY them — the query computes them
 * only with `finance.view`, so there is nothing to hide client-side.
 */
export function ProductPerformanceTable({
  rows,
  parentLabel,
  sort,
}: {
  rows: ProductRow[];
  parentLabel: string;
  sort: { basePath: string; params: Record<string, string>; key: string; dir: "asc" | "desc" };
}) {
  const withFinance = rows.some((r) => "cogs" in r);
  const head = (column: string, label: string, className?: string) => (
    <SortHeader column={column} label={label} basePath={sort.basePath} params={sort.params} active={sort.key === column} dir={sort.dir} className={className} />
  );
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow>
          {head("name", "Produit")}
          <TableHead>Variation</TableHead>
          <TableHead>Catégorie</TableHead>
          {head("units", "Unités", "text-right")}
          {head("orders", parentLabel, "text-right")}
          {head("revenue", "CA", "text-right")}
          {head("returns", "Unités retournées", "text-right")}
          {withFinance && <TableHead className="text-right">Coût</TableHead>}
          {withFinance && <TableHead className="text-right">Bénéfice brut</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="text-muted-foreground">{r.variant ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{r.category ?? "—"}</TableCell>
            <TableCell className="text-right tabular-nums">{r.units}</TableCell>
            <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
            <TableCell className="text-right tabular-nums">{r.returnedUnits}</TableCell>
            {withFinance && <TableCell className="text-right tabular-nums">{money(r.cogs)}</TableCell>}
            {withFinance && <TableCell className="text-right tabular-nums">{money(r.grossProfit)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CategoryPerformanceTable({ rows, parentLabel }: { rows: CategoryRow[]; parentLabel: string }) {
  const withFinance = rows.some((r) => "cogs" in r);
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow>
          <TableHead>Catégorie</TableHead>
          <TableHead className="text-right">Unités</TableHead>
          <TableHead className="text-right">{parentLabel}</TableHead>
          <TableHead className="text-right">CA</TableHead>
          <TableHead className="text-right">Unités retournées</TableHead>
          {withFinance && <TableHead className="text-right">Coût</TableHead>}
          {withFinance && <TableHead className="text-right">Bénéfice brut</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.categoryId ?? "none"}>
            <TableCell className="font-medium">{r.name}</TableCell>
            <TableCell className="text-right tabular-nums">{r.units}</TableCell>
            <TableCell className="text-right tabular-nums">{r.orders}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCurrency(r.revenue)}</TableCell>
            <TableCell className="text-right tabular-nums">{r.returnedUnits}</TableCell>
            {withFinance && <TableCell className="text-right tabular-nums">{money(r.cogs)}</TableCell>}
            {withFinance && <TableCell className="text-right tabular-nums">{money(r.grossProfit)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
