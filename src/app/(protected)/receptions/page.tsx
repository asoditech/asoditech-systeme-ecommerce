import Link from "next/link";
import { PackagePlus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listReceptions } from "@/lib/queries/purchases";
import { displayReceptionNumber, formatCurrency, formatDate } from "@/lib/format";
import { RECEPTION_STATUS_LABELS } from "@/lib/status-labels";
import type { ReceptionStatus } from "@prisma/client";

export const metadata = { title: "Réceptions — ASODITECH Gestion E-commerce" };

/** Purchase receptions: physical stock entering the business (docs/adr/0040). */
export default async function ReceptionsPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const user = await requirePermission("purchases.view");
  const params = await searchParams;
  const status = params.status && params.status in RECEPTION_STATUS_LABELS ? (params.status as ReceptionStatus) : undefined;
  const { receptions, total, page, pageSize } = await listReceptions({ status, page: Number(params.page) || 1 });

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
      {receptions.length === 0 ? (
        <EmptyState icon={PackagePlus} title="Aucune réception pour le moment." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>N°</TableHead>
                <TableHead>Fournisseur</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Lignes</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receptions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    <Link href={`/receptions/${r.id}`} className="hover:underline">
                      {displayReceptionNumber(r)}
                    </Link>
                  </TableCell>
                  <TableCell>{r.supplier.name}</TableCell>
                  <TableCell className="text-muted-foreground">{r.warehouse.name}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(r.receptionDate)}</TableCell>
                  <TableCell>{r._count.lines}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} labels={RECEPTION_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.status === "VALIDEE" ? formatCurrency(r.totalCost.toString()) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/receptions" searchParams={{ status: params.status }} />
        </div>
      )}
    </div>
  );
}
