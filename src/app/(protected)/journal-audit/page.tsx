import Link from "next/link";
import { ScrollText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import {
  humanizeAuditAction,
  humanizeAuditEntity,
  auditEntityHref,
  AUDIT_CATEGORY_LABELS,
  type AuditCategory,
} from "@/lib/audit-labels";
import { listAuditJournal } from "@/lib/queries/audit";

export const metadata = { title: "Journal d'audit — ASODITECH Gestion E-commerce" };


export default async function JournalAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string; page?: string }>;
}) {
  const user = await requirePermission("audit.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const category: AuditCategory | undefined =
    params.category && params.category in AUDIT_CATEGORY_LABELS ? (params.category as AuditCategory) : undefined;

  // Channel read scope (docs/adr/0039) and the payload-free column list
  // (Phase 4C, docs/adr/0044) both live in the query — server-side, for the
  // count and every page of the log.
  const { items: pageItems, total, pageSize } = await listAuditJournal(user, { q: params.q, category, page });

  const hasActiveFilter = Boolean(params.q || category);

  return (
    <div>
      <PageHeader
        title="Journal d'audit"
        description="Historique complet et non modifiable des actions effectuées dans le système."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSearchInput placeholder="Action ou type d'entité..." defaultValue={params.q} className="w-64" />
        <FilterSelect
          paramKey="category"
          value={category}
          allLabel="Toutes les catégories"
          ariaLabel="Catégorie"
          className="w-48"
          options={Object.entries(AUDIT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))}
        />
        {hasActiveFilter ? (
          <Button size="sm" variant="ghost" render={<Link href="/journal-audit" />}>
            Réinitialiser
          </Button>
        ) : null}
      </div>

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
            pageSize={pageSize}
            total={total}
            basePath="/journal-audit"
            searchParams={{ q: params.q, category: params.category }}
          />
        </div>
      )}
    </div>
  );
}
