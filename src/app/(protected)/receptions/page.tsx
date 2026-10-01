import Link from "next/link";
import { PackagePlus, Warehouse } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { EntityAvatar } from "@/components/entity-avatar";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { productCostVisibility } from "@/lib/auth/cost-visibility";
import { listReceptions } from "@/lib/queries/purchases";
import { displayReceptionNumber, formatCurrency, formatDate } from "@/lib/format";
import { RECEPTION_STATUS_LABELS } from "@/lib/status-labels";
import type { ReceptionStatus } from "@prisma/client";

export const metadata = { title: "Réceptions — ASODITECH Gestion E-commerce" };

/** Purchase receptions: physical stock entering the business (docs/adr/0040). */
export default async function ReceptionsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await requirePermission("purchases.view");
  // Reception totals are purchase prices — `purchases.view` (docs/adr/0052).
  const showPrices = productCostVisibility(user).purchasePrices;
  const params = await searchParams;
  const status = params.status && params.status in RECEPTION_STATUS_LABELS ? (params.status as ReceptionStatus) : undefined;
  const { receptions, total, page, pageSize } = await listReceptions({ status, page: Number(params.page) || 1 }, user);

  return (
    <div>
      <PageHeader
        title="Réceptions"
        description="Marchandise reçue des fournisseurs. La validation d'une réception ajoute le stock à l'emplacement de destination."
        actions={
          userHasPermission(user, "purchases.create") ? (
            <Button render={<Link href="/receptions/nouveau" />}>
              <PackagePlus className="size-4" />
              Nouvelle réception
            </Button>
          ) : undefined
        }
      />
      <div className="mb-4">
        <SegmentedControl>
          <SegmentedControlItem active={!status} href="/receptions">
            Toutes
          </SegmentedControlItem>
          {(Object.keys(RECEPTION_STATUS_LABELS) as ReceptionStatus[]).map((key) => (
            <SegmentedControlItem key={key} active={status === key} href={`/receptions?status=${key}`}>
              {RECEPTION_STATUS_LABELS[key].label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      {receptions.length === 0 ? (
        <EmptyState
          icon={PackagePlus}
          title={status ? "Aucune réception avec ce statut." : "Aucune réception pour le moment."}
          description={status ? undefined : "Enregistrez la marchandise reçue d'un fournisseur pour alimenter votre stock."}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Réception</TableHead>
                <TableHead>Fournisseur</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead className="text-right">Articles</TableHead>
                <TableHead>Statut</TableHead>
                {showPrices && <TableHead className="text-right">Total</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {receptions.map((r) => (
                <ClickableTableRow key={r.id} href={`/receptions/${r.id}`}>
                  <TableCell>
                    <Link href={`/receptions/${r.id}`} className="font-semibold text-foreground hover:text-primary hover:underline">
                      {displayReceptionNumber(r)}
                    </Link>
                    <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(r.receptionDate)}</p>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <EntityAvatar name={r.supplier.name} />
                      <span className="font-medium">{r.supplier.name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Warehouse className="size-3.5" />
                      {r.warehouse.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {r._count.lines} ligne{r._count.lines > 1 ? "s" : ""}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} labels={RECEPTION_STATUS_LABELS} />
                  </TableCell>
                  {showPrices && (
                    <TableCell className="text-right font-semibold tabular-nums">
                      {r.status === "VALIDEE" ? formatCurrency(r.totalCost.toString()) : <span className="font-normal text-muted-foreground">—</span>}
                    </TableCell>
                  )}
                </ClickableTableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/receptions" searchParams={{ status: params.status }} />
        </div>
      )}
    </div>
  );
}
