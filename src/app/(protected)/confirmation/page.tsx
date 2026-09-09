import { PhoneCall } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterSearchInput } from "@/components/filter-search-input";
import { KpiCard } from "@/components/kpi-card";
import { ConfirmationQueue, type ConfirmationQueueOrder } from "@/components/orders/confirmation-queue";
import { requirePermission } from "@/lib/auth/guards";
import {
  listOrdersAwaitingConfirmation,
  getMyConfirmationStats,
  CONFIRMATION_RETRY_FLAG,
} from "@/lib/queries/order-confirmation";
import { displayOrderNumber, formatCurrency } from "@/lib/format";

export const metadata = { title: "Confirmation — ASODITECH Gestion E-commerce" };

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const user = await requirePermission("orders.confirm");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const search = params.q?.trim() || undefined;

  const [{ orders, total, pageSize }, stats] = await Promise.all([
    listOrdersAwaitingConfirmation({ page, search }),
    getMyConfirmationStats(user.id),
  ]);

  const queueOrders: ConfirmationQueueOrder[] = orders.map((o) => ({
    id: o.id,
    displayNumber: displayOrderNumber(o),
    customerName: o.customer.fullName,
    customerPhone: o.customer.phone ?? o.shippingPhone ?? null,
    total: o.total.toString(),
    currency: o.currency,
    placedAt: o.placedAt.toISOString(),
    itemCount: o._count.items,
    attemptCount: o.confirmationAttemptCount,
    flagged: o.confirmationAttemptCount >= CONFIRMATION_RETRY_FLAG,
    recentAttempts: o.confirmationAttempts.map((a) => ({
      outcome: a.outcome,
      agentName: a.agent?.name ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
  }));

  return (
    <div>
      <PageHeader
        title="Confirmation des commandes"
        description="File d'attente partagée — appelez le client, puis enregistrez le résultat. Une commande confirmée vous est créditée."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard label="Commandes à confirmer" value={String(total)} icon={PhoneCall} tone="primary" />
        <KpiCard
          label="Confirmées ce mois (vous)"
          value={String(stats.confirmedThisMonth)}
          hint={`${stats.otherAttemptsThisMonth} autre(s) tentative(s)`}
          tone="success"
        />
        <KpiCard
          label="Commission potentielle ce mois"
          value={
            stats.potentialCommission !== null
              ? formatCurrency(stats.potentialCommission, stats.currency)
              : null
          }
          unavailableReason={stats.isAgent ? undefined : "Vous n'êtes pas enregistré comme agent"}
          hint={stats.ratePerOrder !== null ? `${formatCurrency(stats.ratePerOrder, stats.currency)} / commande livrée` : undefined}
          tone="info"
        />
      </div>

      <div className="mb-4">
        <FilterSearchInput paramKey="q" placeholder="N° commande, client, téléphone…" className="w-72 max-w-full" />
      </div>

      {queueOrders.length === 0 ? (
        <EmptyState
          icon={PhoneCall}
          title={search ? "Aucune commande à confirmer ne correspond." : "Aucune commande en attente de confirmation."}
        />
      ) : (
        <div className="space-y-4">
          <ConfirmationQueue orders={queueOrders} />
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/confirmation"
            searchParams={{ q: params.q }}
          />
        </div>
      )}
    </div>
  );
}
