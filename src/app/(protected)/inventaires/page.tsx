import Link from "next/link";
import { ClipboardCheck, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listStocktakeSessions } from "@/lib/queries/stocktakes";
import { formatDateTime, formatStocktakeNumber } from "@/lib/format";
import { STOCKTAKE_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Inventaires — ASODITECH Gestion E-commerce" };

export default async function InventairesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const user = await requirePermission("inventory.view");
  const canCount = hasPermission(user.role, "inventory.count");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const { sessions, total, pageSize } = await listStocktakeSessions({ status: params.status, page });

  return (
    <div>
      <PageHeader
        title="Inventaires"
        description="Comptages physiques du stock, par entrepôt. Le comptage ne modifie pas le stock : l'écart est appliqué à la clôture."
        actions={
          canCount ? (
            <Button render={<Link href="/inventaires/nouveau" />}>
              <Plus className="size-4" />
              Nouvel inventaire
            </Button>
          ) : undefined
        }
      />

      {sessions.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Aucun inventaire." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Référence</TableHead>
                <TableHead>Entrepôt</TableHead>
                <TableHead>Comptées</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Créé le</TableHead>
                <TableHead>Clôturé le</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link href={`/inventaires/${s.id}`} className="hover:underline">
                      {formatStocktakeNumber(s.sessionNumber)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.warehouseName}</TableCell>
                  <TableCell>
                    {s.countedLines} / {s.totalLines}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} labels={STOCKTAKE_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(s.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.closedAt ? formatDateTime(s.closedAt) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/inventaires"
            searchParams={{ status: params.status }}
          />
        </div>
      )}
    </div>
  );
}
