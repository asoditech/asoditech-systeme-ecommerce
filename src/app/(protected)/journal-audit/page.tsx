import Link from "next/link";
import { ScrollText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import {
  humanizeAuditAction,
  humanizeAuditEntity,
  auditEntityHref,
  actionsForCategory,
  AUDIT_CATEGORY_LABELS,
  type AuditCategory,
} from "@/lib/audit-labels";
import type { Prisma } from "@prisma/client";

export const metadata = { title: "Journal d'audit — ASODITECH Gestion E-commerce" };

const PAGE_SIZE = 30;

export default async function JournalAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; page?: string }>;
}) {
  await requirePermission("audit.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const category: AuditCategory | undefined =
    params.category && params.category in AUDIT_CATEGORY_LABELS ? (params.category as AuditCategory) : undefined;

  const conditions: Prisma.AuditEventWhereInput[] = [];
  if (params.q) {
    conditions.push({
      OR: [
        { action: { contains: params.q, mode: "insensitive" } },
        { entityType: { contains: params.q, mode: "insensitive" } },
      ],
    });
  }
  if (category) {
    conditions.push({ action: { in: actionsForCategory(category) } });
  }
  const where: Prisma.AuditEventWhereInput = conditions.length > 0 ? { AND: conditions } : {};

  const [pageItems, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      include: { actorUser: { select: { name: true, email: true } } },
    }),
    prisma.auditEvent.count({ where }),
  ]);

  const hasActiveFilter = Boolean(params.q || category);

  return (
    <div>
      <PageHeader
        title="Journal d'audit"
        description="Historique complet et non modifiable des actions effectuées dans le système."
      />

      <form className="mb-4 flex flex-wrap gap-2" action="/journal-audit">
        <Input name="q" placeholder="Rechercher par action ou type d'entité..." defaultValue={params.q} className="max-w-56" />
        <Select name="category" defaultValue={category || "all"}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Catégorie">
              {category ? AUDIT_CATEGORY_LABELS[category] : "Toutes les catégories"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes les catégories</SelectItem>
            {Object.entries(AUDIT_CATEGORY_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" variant="outline">
          Filtrer
        </Button>
        {hasActiveFilter ? (
          <Button variant="ghost" render={<Link href="/journal-audit" />}>
            Réinitialiser
          </Button>
        ) : null}
      </form>

      {pageItems.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={hasActiveFilter ? "Aucun évènement ne correspond à ces critères." : "Aucun évènement enregistré."}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Acteur</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Concerne</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((e) => {
                const href = auditEntityHref(e.entityType, e.entityId);
                const entityLabel = (
                  <>
                    {humanizeAuditEntity(e.entityType)}{" "}
                    <span className="font-mono text-xs">#{e.entityId.slice(0, 8)}</span>
                  </>
                );
                return (
                  <TableRow key={e.id}>
                    <TableCell>
                      <p className="font-medium">{e.actorUser?.name ?? (e.actorType === "INTEGRATION" ? "Automatique" : "Système")}</p>
                      <p className="text-xs text-muted-foreground">
                        {e.actorUser?.email ?? (e.actorType === "INTEGRATION" ? "Intégration (WooCommerce/Shopify)" : "Système")}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{humanizeAuditAction(e.action)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {href ? (
                        <Link href={href} className="hover:underline">
                          {entityLabel}
                        </Link>
                      ) : (
                        entityLabel
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            basePath="/journal-audit"
            searchParams={{ q: params.q, category: params.category }}
          />
        </div>
      )}
    </div>
  );
}
