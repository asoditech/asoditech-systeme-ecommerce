import Link from "next/link";
import { ShoppingCart, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { DataTablePagination } from "@/components/data-table-pagination";
import { redirect } from "next/navigation";
import { PAGE_SIZE_OPTIONS, outOfRangeHref, parsePage, parsePageSize } from "@/lib/pagination";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { StopPropagationLink } from "@/components/stop-propagation-link";
import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { FilterSelect } from "@/components/filter-select";
import { DateRangeFields } from "@/components/date-range-fields";
import { FilterSearchInput } from "@/components/filter-search-input";
import { orderSearchFeedback } from "@/lib/orders/search-feedback";
import { DisconnectedSourceBanner } from "@/components/integrations/disconnected-source-banner";
import { SyncRefreshButton } from "@/components/sync-refresh-button";
import { getConnectedCommercePlatforms } from "@/lib/integrations/shared";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterBar, FilterChip } from "@/components/filter-bar";
import { ProductChips } from "@/components/orders/product-chips";
import { OrderRowActions } from "@/components/orders/order-row-actions";
import { isPurgeCandidate } from "@/lib/orders/purge-ui";
import { productLineLabel } from "@/lib/catalog/product-chips";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listOrders } from "@/lib/queries/orders";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import {
  formatCurrency,
  formatDate,
  displayOrderNumber,
  displayOrderChannel,
  displayOrderRecipient,
  returnStateLabel,
} from "@/lib/format";
import { ORDER_STATUS_LABELS, ORDER_PAYMENT_STATUS_LABELS } from "@/lib/status-labels";
import type { OrderStatus, OrderPaymentStatus } from "@prisma/client";
import { getBusinessTimeZone } from "@/lib/time/business-zone";
import { zonedMonthDayKeys } from "@/lib/time/zoned";

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
    pageSize?: string;
    confirmationAgent?: string;
  }>;
}) {
  const user = await requirePermission("orders.view");
  const params = await searchParams;
  const page = parsePage(params.page);
  // « Afficher 10 | 50 | 100 par page » — only an allowed size is accepted (default 10).
  const pageSize = parsePageSize(params.pageSize);
  const canSync =
    userHasPermission(user, "integrations.manage") && (await getConnectedCommercePlatforms()).length > 0;
  const canViewCommissions = userHasPermission(user, "commissions.view");
  // Row menu = the order page's own « Purger cette commande de test », same
  // permission (orders.purge — OWNER/ADMIN) and same server action.
  const canPurge = userHasPermission(user, "orders.purge");

  // "Tous les statuts" / "Tous les paiements" submit the sentinel "all";
  // only a real enum value is passed through to the query, otherwise
  // Prisma rejects `status: "all"` and the whole page fails to load.
  const statusFilter =
    params.status && ORDER_STATUS_LABELS[params.status] ? (params.status as OrderStatus) : undefined;
  const paymentStatusFilter =
    params.paymentStatus && ORDER_PAYMENT_STATUS_LABELS[params.paymentStatus]
      ? (params.paymentStatus as OrderPaymentStatus)
      : undefined;

  // The current month of the business time zone (not the server's).
  const { first: monthFrom, last: monthTo } = zonedMonthDayKeys(new Date(), await getBusinessTimeZone());

  // `all=1` is the explicit escape hatch out of the default month scope
  // (see "Toutes les commandes" below) — without it, no date filter means
  // "this month", not the whole order history.
  const isAll = params.all === "1";
  const effectiveDateFrom = params.dateFrom || (isAll ? undefined : monthFrom);
  const effectiveDateTo = params.dateTo || (isAll ? undefined : monthTo);

  const [{ orders, total }, business] = await Promise.all([
    listOrders({
      q: params.q,
      status: statusFilter,
      paymentStatus: paymentStatusFilter,
      dateFrom: effectiveDateFrom,
      dateTo: effectiveDateTo,
      confirmationAgentId: params.confirmationAgent,
      page,
      pageSize,
    }),
    getReportBusinessInfo(),
  ]);
  // Past the last page (e.g. its last order was just purged) → the last page, same filters.
  const outOfRange = outOfRangeHref({ page, total, pageSize, basePath: "/commandes", searchParams: params });
  if (outOfRange) redirect(outOfRange);
  const confirmationAgentName = params.confirmationAgent
    ? orders.find((o) => o.confirmationAgent)?.confirmationAgent?.user.name ?? "cet agent"
    : null;

  const isThisMonth = effectiveDateFrom === monthFrom && effectiveDateTo === monthTo;
  const searchFeedback = orderSearchFeedback({ q: params.q, total, scopedToThisMonth: isThisMonth });
  const hasActiveFilter = Boolean(
    params.q || statusFilter || paymentStatusFilter || params.dateFrom || params.dateTo || isAll || params.confirmationAgent
  );

  // The default scope is "this month". After a first import (or for a
  // store whose recent orders are all older than the current month), that
  // view is empty even though the history isn't — so when it is, check
  // whether widening the date scope would actually show something and
  // point the operator straight at it instead of a dead end.
  const olderOrdersExist =
    orders.length === 0 && isThisMonth && !params.q && !statusFilter && !paymentStatusFilter && !params.confirmationAgent
      ? (await listOrders({ page: 1 })).total > 0
      : false;

  // Preserves q/status/paymentStatus/confirmationAgent while switching only the date scope.
  function dateScopeHref(opts: { dateFrom?: string; dateTo?: string; all?: boolean }) {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (statusFilter) sp.set("status", statusFilter);
    if (paymentStatusFilter) sp.set("paymentStatus", paymentStatusFilter);
    if (params.confirmationAgent) sp.set("confirmationAgent", params.confirmationAgent);
    if (params.pageSize) sp.set("pageSize", String(pageSize));
    if (opts.all) {
      sp.set("all", "1");
    } else if (opts.dateFrom && opts.dateTo) {
      sp.set("dateFrom", opts.dateFrom);
      sp.set("dateTo", opts.dateTo);
    }
    const qs = sp.toString();
    return qs ? `/commandes?${qs}` : "/commandes";
  }

  // Drops only the confirmationAgent param, keeping every other active filter.
  function clearConfirmationAgentHref() {
    const sp = new URLSearchParams();
    if (params.q) sp.set("q", params.q);
    if (statusFilter) sp.set("status", statusFilter);
    if (paymentStatusFilter) sp.set("paymentStatus", paymentStatusFilter);
    if (params.dateFrom) sp.set("dateFrom", params.dateFrom);
    if (params.dateTo) sp.set("dateTo", params.dateTo);
    if (isAll) sp.set("all", "1");
    if (params.pageSize) sp.set("pageSize", String(pageSize));
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
            {userHasPermission(user, "orders.create") && (
              <Button render={<Link href="/commandes/nouvelle" />}>
                <Plus className="size-4" />
                Nouvelle commande
              </Button>
            )}
          </div>
        }
      />

      <DisconnectedSourceBanner entity="order" />

      <FilterBar>
        <FilterSearchInput
          placeholder="N° commande, client, téléphone, n° de suivi…"
          ariaLabel="Rechercher une commande par n° de commande, client, téléphone ou n° de suivi"
          defaultValue={params.q}
          className="w-full sm:w-72"
          // Search as you type (Enter still applies at once).
          liveDebounceMs={300}
        />
        <FilterSelect
          paramKey="status"
          value={statusFilter}
          allLabel="Tous les statuts"
          ariaLabel="Statut"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-44"
          options={Object.entries(ORDER_STATUS_LABELS).map(([value, meta]) => ({ value, label: meta.label }))}
        />
        <FilterSelect
          paramKey="paymentStatus"
          value={paymentStatusFilter}
          allLabel="Tous les paiements"
          ariaLabel="Paiement"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-48"
          options={Object.entries(ORDER_PAYMENT_STATUS_LABELS).map(([value, meta]) => ({ value, label: meta.label }))}
        />
        <form className="flex max-w-full flex-wrap items-center gap-2" action="/commandes">
          {statusFilter ? <input type="hidden" name="status" value={statusFilter} /> : null}
          {paymentStatusFilter ? <input type="hidden" name="paymentStatus" value={paymentStatusFilter} /> : null}
          {params.q ? <input type="hidden" name="q" value={params.q} /> : null}
          {params.pageSize ? <input type="hidden" name="pageSize" value={pageSize} /> : null}
          <span className="text-xs text-ink-muted" title="Date à laquelle la commande a été passée — pas la date d'expédition.">
            Commandes passées
          </span>
          <DateRangeFields
            idPrefix="orders-placed"
            fromName="dateFrom"
            toName="dateTo"
            from={effectiveDateFrom}
            to={effectiveDateTo}
            fromAriaLabel="Commandes passées à partir du"
            toAriaLabel="Commandes passées jusqu'au"
          />
          <Button type="submit" variant="outline">
            Filtrer
          </Button>
        </form>
        {/* Period presets are a choice between positions, not actions — a
            segmented control, never a solid primary button that competes
            with "Nouvelle commande". */}
        <SegmentedControl>
          <SegmentedControlItem active={isThisMonth} href={dateScopeHref({ dateFrom: monthFrom, dateTo: monthTo })}>
            Ce mois-ci
          </SegmentedControlItem>
          <SegmentedControlItem active={isAll} href={dateScopeHref({ all: true })}>
            Toute la période
          </SegmentedControlItem>
        </SegmentedControl>
        {hasActiveFilter ? (
          <Button variant="ghost" render={<Link href={params.pageSize ? `/commandes?pageSize=${pageSize}` : "/commandes"} />}>
            Réinitialiser
          </Button>
        ) : null}
      </FilterBar>
      {/* Polite live region: announced after each search (« 3 résultats pour … »). */}
      <p role="status" aria-live="polite" className={searchFeedback ? "-mt-2 mb-3 text-sm text-ink-secondary" : "sr-only"} data-testid="orders-search-feedback">
        {searchFeedback ?? ""}
      </p>

      {params.confirmationAgent && (
        <div className="-mt-2 mb-5">
          <FilterChip href={clearConfirmationAgentHref()} label="Filtré par agent :" value={confirmationAgentName} />
        </div>
      )}

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
        <TableCard>
          <Table className="[&_td]:px-2.5 [&_th]:px-2.5 2xl:[&_td]:px-3 2xl:[&_th]:px-3">
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Paiement</TableHead>
                {/* Lower-priority column: from 2xl only; below, the channel is on the order's second line. */}
                <TableHead className="hidden 2xl:table-cell">Canal</TableHead>
                <TableHead>Confirmé par</TableHead>
                <TableHead>Produits</TableHead>
                {canPurge && (
                  <TableHead className="w-10">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                // Batch 9, Group 5: an Order is always the Online side of the
                // business (docs/adr/0038) — Sale is the separate Offline
                // model — so this only ever reads "En ligne" or, for a
                // legacy/unattributed row (nullable salesChannelId), the
                // existing neutral state (no badge), never an invented one.
                const returnLabel = returnStateLabel(
                  o.items.reduce((s, i) => s + i.quantity, 0),
                  o.returns.flatMap((r) => r.lines).reduce((s, l) => s + l.quantitySellable + l.quantityDamaged, 0)
                );
                return (
                <ClickableTableRow key={o.id} href={`/commandes/${o.id}`}>
                  <TableCell>
                    <span className="text-[15px] font-semibold tracking-tight text-ink">{displayOrderNumber(o, business.orderNumberPrefix)}</span>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {formatDate(o.placedAt)} · {o._count.items} article{o._count.items > 1 ? "s" : ""}
                      <span className="2xl:hidden"> · {displayOrderChannel(o)}</span>
                    </p>
                    {/* Own line, not beside the number: keeps the column narrow so the table fits at 1440px. */}
                    {returnLabel && <Badge variant="warning" className="mt-1">↩ {returnLabel}</Badge>}
                  </TableCell>
                  <TableCell>
                    <span className="block max-w-[11rem] truncate font-medium text-ink">{displayOrderRecipient(o)}</span>
                    <span className="block max-w-[11rem] truncate text-xs text-ink-muted">{o.shippingCity ?? "Ville non renseignée"}</span>
                  </TableCell>
                  <TableCell className="text-right font-semibold text-ink tabular-nums">{formatCurrency(o.total.toString(), o.currency)}</TableCell>
                  <TableCell>
                    <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={o.paymentStatus} labels={ORDER_PAYMENT_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="hidden text-ink-secondary 2xl:table-cell">{displayOrderChannel(o)}</TableCell>
                  <TableCell className="text-ink-secondary">
                    {o.confirmationAgent ? (
                      canViewCommissions ? (
                        <StopPropagationLink
                          href={`/commissions/${o.confirmationAgentId}`}
                          className="max-w-[7rem] truncate hover:underline"
                        >
                          {o.confirmationAgent.user.name}
                        </StopPropagationLink>
                      ) : (
                        <span className="block max-w-[7rem] truncate">{o.confirmationAgent.user.name}</span>
                      )
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <ProductChips lines={o.items.map((i) => ({ name: i.nameSnapshot, quantity: i.quantity, attributes: i.variation?.attributes }))} />
                  </TableCell>
                  {canPurge && (
                    <TableCell className="w-10" data-row-actions="">
                      {isPurgeCandidate(o) && (
                        <OrderRowActions
                          orderHref={`/commandes/${o.id}`}
                          summary={{
                            orderId: o.id,
                            orderLabel: displayOrderNumber(o, business.orderNumberPrefix),
                            statusLabel: ORDER_STATUS_LABELS[o.status]?.label ?? o.status,
                            customerName: displayOrderRecipient(o),
                            total: formatCurrency(o.total.toString(), o.currency),
                            lines: o.items.map((i) => ({
                              name: productLineLabel(i.nameSnapshot, i.variation?.attributes),
                              sku: i.skuSnapshot,
                              quantity: i.quantity,
                            })),
                          }}
                        />
                      )}
                    </TableCell>
                  )}
                </ClickableTableRow>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/commandes"
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            searchParams={{
              q: params.q,
              status: statusFilter,
              paymentStatus: paymentStatusFilter,
              dateFrom: params.dateFrom,
              dateTo: params.dateTo,
              all: params.all,
              confirmationAgent: params.confirmationAgent,
            }}
          />
        </TableCard>
      )}
    </div>
  );
}
