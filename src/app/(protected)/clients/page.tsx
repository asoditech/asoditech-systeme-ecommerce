import Link from "next/link";
import { Users, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listCustomers } from "@/lib/queries/customers";
import { formatDate } from "@/lib/format";
import { CUSTOMER_SEGMENT_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Clients — ASODITECH Gestion E-commerce" };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePermission("customers.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const { customers, total, pageSize } = await listCustomers({ q: params.q, page });

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

      <form className="mb-4 flex gap-2" action="/clients">
        <Input
          name="q"
          placeholder="Rechercher par nom, téléphone, e-mail..."
          defaultValue={params.q}
          className="max-w-sm"
        />
        <Button type="submit" variant="outline">
          Rechercher
        </Button>
      </form>

      {customers.length === 0 ? (
        <EmptyState
          icon={Users}
          title={params.q ? "Aucun client ne correspond à votre recherche." : "Aucun client pour le moment."}
          description={
            params.q ? undefined : "Ajoutez votre premier client pour commencer à suivre ses commandes."
          }
          action={
            !params.q && hasPermission(user.role, "customers.create") ? (
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
            searchParams={{ q: params.q }}
          />
        </div>
      )}
    </div>
  );
}
