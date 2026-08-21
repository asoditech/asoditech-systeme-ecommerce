import Link from "next/link";
import { ShoppingCart, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listOrders } from "@/lib/queries/orders";
import { formatCurrency, formatDate, formatOrderNumber } from "@/lib/format";
import { ORDER_STATUS_LABELS, ORDER_PAYMENT_STATUS_LABELS } from "@/lib/status-labels";
import type { OrderStatus, OrderPaymentStatus } from "@prisma/client";

export const metadata = { title: "Commandes — ASODITECH Gestion E-commerce" };

export default async function CommandesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    paymentStatus?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("orders.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const { orders, total, pageSize } = await listOrders({
    q: params.q,
    status: (params.status as OrderStatus) || undefined,
    paymentStatus: (params.paymentStatus as OrderPaymentStatus) || undefined,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    page,
  });

  return (
    <div>
      <PageHeader
        title="Commandes"
        description="Toutes les commandes, leur statut et leur suivi de livraison."
        actions={
          hasPermission(user.role, "orders.create") ? (
            <Button render={<Link href="/commandes/nouvelle" />}>
              <Plus className="size-4" />
              Nouvelle commande
            </Button>
          ) : undefined
        }
      />

      <form className="mb-4 flex flex-wrap gap-2" action="/commandes">
        <Input name="q" placeholder="N° commande, client..." defaultValue={params.q} className="max-w-56" />
        <Select name="status" defaultValue={params.status || "all"}>
          <SelectTrigger className="w-44">
            {/* SelectValue's dynamic-label children must be a plain
                ReactNode here, never a function — this page is a Server
                Component and SelectValue is a Client Component, and a
                closure can't cross that boundary (found via live browser
                verification during the layout redesign; see the other
                (client-component) Select usages elsewhere in the app,
                where the function-children form is fine). */}
            <SelectValue placeholder="Statut">
              {params.status && params.status !== "all" ? (ORDER_STATUS_LABELS[params.status]?.label ?? params.status) : "Tous les statuts"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les statuts</SelectItem>
            {Object.entries(ORDER_STATUS_LABELS).map(([value, meta]) => (
              <SelectItem key={value} value={value}>
                {meta.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select name="paymentStatus" defaultValue={params.paymentStatus || "all"}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="Paiement">
              {params.paymentStatus && params.paymentStatus !== "all"
                ? (ORDER_PAYMENT_STATUS_LABELS[params.paymentStatus]?.label ?? params.paymentStatus)
                : "Tous les paiements"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tous les paiements</SelectItem>
            {Object.entries(ORDER_PAYMENT_STATUS_LABELS).map(([value, meta]) => (
              <SelectItem key={value} value={value}>
                {meta.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" name="dateFrom" defaultValue={params.dateFrom} className="w-40" />
        <Input type="date" name="dateTo" defaultValue={params.dateTo} className="w-40" />
        <Button type="submit" variant="outline">
          Filtrer
        </Button>
      </form>

      {orders.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title="Aucune commande ne correspond à ces critères."
          description="Créez une commande manuelle ou ajustez vos filtres."
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Articles</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Paiement</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <ClickableTableRow key={o.id} href={`/commandes/${o.id}`}>
                  <TableCell className="font-medium">{formatOrderNumber(o.orderNumber)}</TableCell>
                  <TableCell>{o.customer.fullName}</TableCell>
                  <TableCell className="text-muted-foreground">{o._count.items}</TableCell>
                  <TableCell>{formatCurrency(o.total.toString(), o.currency)}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.paymentStatus} labels={ORDER_PAYMENT_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(o.createdAt)}</TableCell>
                </ClickableTableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/commandes"
            searchParams={{ q: params.q, status: params.status, paymentStatus: params.paymentStatus, dateFrom: params.dateFrom, dateTo: params.dateTo }}
          />
        </div>
      )}
    </div>
  );
}
