import { ScrollText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";

export const metadata = { title: "Journal d'audit — ASODITECH Gestion E-commerce" };

const PAGE_SIZE = 30;

export default async function JournalAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requirePermission("audit.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const where = params.q
    ? {
        OR: [
          { action: { contains: params.q, mode: "insensitive" as const } },
          { entityType: { contains: params.q, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [events, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { actorUser: { select: { name: true, email: true } } },
    }),
    prisma.auditEvent.count({ where }),
  ]);

  return (
    <div>
      <PageHeader
        title="Journal d'audit"
        description="Historique complet et non modifiable des actions effectuées dans le système."
      />

      <form className="mb-4 flex gap-2" action="/journal-audit">
        <Input name="q" placeholder="Rechercher par action ou type d'entité..." defaultValue={params.q} className="max-w-sm" />
        <Button type="submit" variant="outline">
          Rechercher
        </Button>
      </form>

      {events.length === 0 ? (
        <EmptyState icon={ScrollText} title="Aucun évènement enregistré." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Acteur</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entité</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <p className="font-medium">{e.actorUser?.name ?? "Système"}</p>
                    <p className="text-xs text-muted-foreground">{e.actorUser?.email ?? e.actorType}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono">
                      {e.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {e.entityType} <span className="font-mono text-xs">#{e.entityId.slice(0, 8)}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/journal-audit" searchParams={{ q: params.q }} />
        </div>
      )}
    </div>
  );
}
