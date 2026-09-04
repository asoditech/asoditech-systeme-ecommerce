import Link from "next/link";
import { Users, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listCustomers, type CustomerSort } from "@/lib/queries/customers";
import { formatDate } from "@/lib/format";
import { CUSTOMER_SEGMENT_LABELS, RECORD_SOURCE_LABELS } from "@/lib/status-labels";
import type { CustomerSegment, RecordSource } from "@prisma/client";

export const metadata = { title: "Clients — ASODITECH Gestion E-commerce" };

const SORT_LABELS: Record<CustomerSort, string> = {
  recent: "Plus récents",
  name: "Nom (A–Z)",
  orders: "Nb de commandes",
};

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    segment?: string;
    source?: string;
    city?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("customers.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const segmentFilter =
    params.segment && CUSTOMER_SEGMENT_LABELS[params.segment]
      ? (params.segment as CustomerSegment)
      : undefined;
  const sourceFilter =
    params.source && RECORD_SOURCE_LABELS[params.source] ? (params.source as RecordSource) : undefined;
  const sortFilter: CustomerSort =
    params.sort === "name" || params.sort === "orders" ? params.sort : "recent";

  const { customers, total, pageSize } = await listCustomers({
    q: params.q,
    segment: segmentFilter,
    source: sourceFilter,
    city: params.city,
    sort: sortFilter,
    page,
  });

  const hasActiveFilter = Boolean(
    params.q || segmentFilter || sourceFilter || params.city || params.sort
  );
  const paginationParams = {
    q: params.q,
    segment: segmentFilter,
    source: sourceFilter,
    city: params.city,
    sort: params.sort,
  };

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Gérez votre base de clients et leur historique de commandes."
        actions={
          hasPermission(user.role, "customers.create") ? (
            <Button render={<Link href="/clients/nouveau" />}>
              <Plus className="size-4" />
              Nouveau client
            </Button>
          ) : undefined
        }
      />

      <form className="mb-4 flex flex-wrap gap-2" action="/clients">
        <Input name="q" placeholder="Nom, téléphone, e-mail..." defaultValue={params.q} className="max-w-56" />
        <Input name="city" placeholder="Ville" defaultValue={params.city} className="w-36" />
        <Select name="segment" defaultValue={params.segment || "all"}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Segment">
              {segmentFilter ? CUSTOMER_SEGMENT_LABELS[segmentFilter] : "Tous les segments"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les segments</SelectItem>
            {Object.entries(CUSTOMER_SEGMENT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="source" defaultValue={params.source || "all"}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Origine">
              {sourceFilter ? RECORD_SOURCE_LABELS[sourceFilter] : "Toutes origines"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toutes origines</SelectItem>
            {Object.entries(RECORD_SOURCE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="sort" defaultValue={sortFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Trier">{SORT_LABELS[sortFilter]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(SORT_LABELS).map(([value, label]) => (
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
          <Button variant="ghost" render={<Link href="/clients" />}>
            Réinitialiser
          </Button>
        ) : null}
      </form>

      {customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            hasActiveFilter
              ? "Aucun client ne correspond à ces critères."
              : "Aucun client pour le moment."
          }
          description={
            hasActiveFilter
              ? undefined
              : "Ajoutez votre premier client pour commencer à suivre ses commandes."
          }
          action={
            !hasActiveFilter && hasPermission(user.role, "customers.create") ? (
              <Button render={<Link href="/clients/nouveau" />}>Ajouter un client</Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Ville</TableHead>
                <TableHead>Segment</TableHead>
                <TableHead>Commandes</TableHead>
                <TableHead>Ajouté le</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((c) => (
                <ClickableTableRow key={c.id} href={`/clients/${c.id}`}>
                  <TableCell className="font-medium">{c.fullName}</TableCell>
                  <TableCell className="text-muted-foreground">{c.phone ?? c.email ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.city ?? "—"}</TableCell>
                  <TableCell>
                    {c.segment ? (
                      <Badge variant="secondary">{CUSTOMER_SEGMENT_LABELS[c.segment]}</Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">Non segmenté</span>
                    )}
                  </TableCell>
                  <TableCell>{c._count.orders}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                </ClickableTableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/clients"
            searchParams={paginationParams}
          />
        </div>
      )}
    </div>
  );
}
