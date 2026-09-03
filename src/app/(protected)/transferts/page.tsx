import Link from "next/link";
import { ArrowLeftRight, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listStockTransfers } from "@/lib/queries/transfers";
import { formatDateTime, formatTransferNumber } from "@/lib/format";
import { TRANSFER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Transferts — ASODITECH Gestion E-commerce" };

export default async function TransfertsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const user = await requirePermission("inventory.view");
  const canTransfer = hasPermission(user.role, "inventory.transfer");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const { transfers, total, pageSize } = await listStockTransfers({ status: params.status, page });

  return (
    <div>
      <PageHeader
        title="Transferts de stock"
        description="Déplacements de stock entre entrepôts et magasins."
        actions={
          canTransfer ? (
            <Button render={<Link href="/transferts/nouveau" />}>
              <Plus className="size-4" />
              Nouveau transfert
            </Button>
          ) : undefined
        }
      />

      {transfers.length === 0 ? (
        <EmptyState icon={ArrowLeftRight} title="Aucun transfert." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Lignes</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Créé le</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    <Link href={`/transferts/${t.id}`} className="hover:underline">
                      {formatTransferNumber(t.transferNumber)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.source.name}</TableCell>
                  <TableCell className="text-muted-foreground">{t.destination.name}</TableCell>
                  <TableCell>{t._count.lines}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} labels={TRANSFER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(t.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/transferts"
            searchParams={{ status: params.status }}
          />
        </div>
      )}
    </div>
  );
}
