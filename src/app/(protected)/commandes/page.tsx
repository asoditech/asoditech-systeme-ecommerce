import Link from "next/link";
import { ShoppingCart, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { DisconnectedSourceBanner } from "@/components/integrations/disconnected-source-banner";
import { SyncRefreshButton } from "@/components/sync-refresh-button";
import { getConnectedCommercePlatforms } from "@/lib/integrations/shared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listOrders } from "@/lib/queries/orders";
import { formatCurrency, formatDate, displayOrderNumber, displayOrderChannel, displayOrderRecipient } from "@/lib/format";
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
    all?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("orders.view");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const canSync =
    hasPermission(user.role, "integrations.manage") && (await getConnectedCommercePlatforms()).length > 0;

  // "Tous les statuts" / "Tous les paiements" submit the sentinel "all";
  // only a real enum value is passed through to the query, otherwise
  // Prisma rejects `status: "all"` and the whole page fails to load.
  const statusFilter =
    params.status && ORDER_STATUS_LABELS[params.status] ? (params.status as OrderStatus) : undefined;
  const paymentStatusFilter =
    params.paymentStatus && ORDER_PAYMENT_STATUS_LABELS[params.paymentStatus]
      ? (params.paymentStatus as OrderPaymentStatus)
      : undefined;

  const now = new Date();
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString("en-CA");
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 0).toLocaleDateString("en-CA");

  // `all=1` is the explicit escape hatch out of the default month scope
  // (see "Toutes les commandes" below) — without it, no date filter means
  // "this month", not the whole order history.
  const isAll = params.all === "1";
  const effectiveDateFrom = params.dateFrom || (isAll ? undefined : monthFrom);
  const effectiveDateTo = params.dateTo || (isAll ? undefined : monthTo);

  const { orders, total, pageSize } = await listOrders({
    q: params.q,
    status: statusFilter,
    paymentStatus: paymentStatusFilter,
    dateFrom: effectiveDateFrom,
    dateTo: effectiveDateTo,
    page,
  });

  const isThisMonth = effectiveDateFrom === monthFrom && effectiveDateTo === monthTo;
  const hasActiveFilter = Boolean(
    params.q || statusFilter || paymentStatusFilter || params.dateFrom || params.dateTo || isAll
  );

  // The default scope is "this month". After a first import (or for a
  // store whose recent orders are all older than the current month), that
  // view is empty even though the history isn't — so when it is, check
  // whether widening the date scope would actually show something and
  // point the operator straight at it instead of a dead end.
  const olderOrdersExist =
    orders.length === 0 && isThisMonth && !params.q && !statusFilter && !paymentStatusFilter
      ? (await listOrders({ page: 1 })).total > 0
      : false;

  // Preserves q/status/paymentStatus while switching only the date scope.
  function dateScopeHref(opts: { dateFrom?: string; dateTo?: string; all?: boolean }) {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (statusFilter) sp.set("status", statusFilter);
    if (paymentStatusFilter) sp.set("paymentStatus", paymentStatusFilter);
    if (opts.all) {
      sp.set("all", "1");
    } else if (opts.dateFrom && opts.dateTo) {
      sp.set("dateFrom", opts.dateFrom);
      sp.set("dateTo", opts.dateTo);
    }
    const qs = sp.toString();
    return qs ? `/commandes?${qs}` : "/commandes";
  }

  return (
    <div>
      <PageHeader
        title="Commandes"
        description="Toutes les commandes, leur statut et leur suivi de livraison."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SyncRefreshButton resource="orders" canSync={canSync} />
            {hasPermission(user.role, "orders.create") && (
              <Button render={<Link href="/commandes/nouvelle" />}>
                <Plus className="size-4" />
                Nouvelle commande
              </Button>
            )}
          </div>
        }
      />

      <DisconnectedSourceBanner entity="order" />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterSearchInput placeholder="N° commande, client..." defaultValue={params.q} className="w-56" />
        <FilterSelect
          paramKey="status"
          value={statusFilter}
          allLabel="Tous les statuts"
          ariaLabel="Statut"
          className="w-44"
          options={Object.entries(ORDER_STATUS_LABELS).map(([value, meta]) => ({ value, label: meta.label }))}
        />
        <FilterSelect
          paramKey="paymentStatus"
          value={paymentStatusFilter}
          allLabel="Tous les paiements"
          ariaLabel="Paiement"
          className="w-48"
          options={Object.entries(ORDER_PAYMENT_STATUS_LABELS).map(([value, meta]) => ({ value, label: meta.label }))}
        />
        <form className="flex items-center gap-2" action="/commandes">
          {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
          {paymentStatusFilter ? <input type="hidden" name="paymentStatus" value={paymentStatusFilter} /> : null}
          {params.q ? <input type="hidden" name="q" value={params.q} /> : null}
          <Input type="date" name="dateFrom" defaultValue={effectiveDateFrom} className="w-40" aria-label="Date de début" />
          <Input type="date" name="dateTo" defaultValue={effectiveDateTo} className="w-40" aria-label="Date de fin" />
          <Button type="submit" size="sm" variant="outline">
            Filtrer
          </Button>
        </form>
        <Button
          size="sm"
          variant={isThisMonth ? "default" : "ghost"}
          render={<Link href={dateScopeHref({ dateFrom: monthFrom, dateTo: monthTo })} />}
        >
          Ce mois-ci
        </Button>
        <Button size="sm" variant={isAll ? "default" : "ghost"} render={<Link href={dateScopeHref({ all: true })} />}>
          Toutes les commandes
        </Button>
        {hasActiveFilter ? (
          <Button size="sm" variant="ghost" render={<Link href="/commandes" />}>
            Réinitialiser
          </Button>
        ) : null}
      </div>

      {orders.length === 0 ? (
        olderOrdersExist ? (
          <EmptyState
            icon={ShoppingCart}
            title="Aucune commande ce mois-ci."
            description="Des commandes plus anciennes existent (import ou historique). Affichez toute la période pour les voir."
            action={
              <Button render={<Link href={dateScopeHref({ all: true })} />}>Voir toutes les commandes</Button>
            }
          />
        ) : (
          <EmptyState
            icon={ShoppingCart}
            title="Aucune commande ne correspond à ces critères."
            description="Créez une commande manuelle ou ajustez vos filtres."
          />
        )
      ) : (
        <div className="rounded-lg border">
          <Table className="text-[13px] [&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5">
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Ville</TableHead>
                <TableHead className="text-right">Art.</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Paiement</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <ClickableTableRow key={o.id} href={`/commandes/${o.id}`}>
                  <TableCell className="font-medium">{displayOrderNumber(o)}</TableCell>
                  <TableCell>
                    <span className="block max-w-[8rem] truncate">{displayOrderRecipient(o)}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className="block max-w-[7rem] truncate">{o.shippingCity ?? "—"}</span>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{o._count.items}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(o.total.toString(), o.currency)}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.paymentStatus} labels={ORDER_PAYMENT_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{displayOrderChannel(o)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(o.placedAt)}</TableCell>
                </ClickableTableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/commandes"
            searchParams={{
              q: params.q,
              status: statusFilter,
              paymentStatus: paymentStatusFilter,
              dateFrom: params.dateFrom,
              dateTo: params.dateTo,
              all: params.all,
            }}
          />
        </div>
      )}
    </div>
  );
}
