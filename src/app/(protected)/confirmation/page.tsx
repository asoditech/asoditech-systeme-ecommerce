import Link from "next/link";
import { PhoneCall, RotateCcw, CheckCircle2, UserCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterSearchInput } from "@/components/filter-search-input";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { ConfirmationQueue, type ConfirmationQueueOrder } from "@/components/orders/confirmation-queue";
import { ConfirmedOrdersList, type ConfirmedOrderRow } from "@/components/orders/confirmed-orders-list";
import { requirePermission } from "@/lib/auth/guards";
import {
  listOrdersAwaitingConfirmation,
  listRecentlyConfirmedOrders,
  listOrdersConfirmedByAgent,
  getMyConfirmationStats,
  getConfirmationDashboardSummary,
  CONFIRMATION_RETRY_FLAG,
} from "@/lib/queries/order-confirmation";
import {
  getCommissionAgentIdForUser,
  getAgentOrderPipeline,
  getAgentCommissionBreakdown,
} from "@/lib/queries/commissions";
import { displayOrderNumber, displayOrderRecipient, formatCurrency } from "@/lib/format";

export const metadata = { title: "Confirmation — ASODITECH Gestion E-commerce" };

const TABS = [
  { key: "a-confirmer", label: "À confirmer", icon: PhoneCall },
  { key: "rappeler", label: "À rappeler", icon: RotateCcw },
  { key: "confirmees", label: "Confirmées", icon: CheckCircle2 },
  { key: "mes-confirmations", label: "Mes confirmations", icon: UserCheck },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type QueueSourceOrder = Awaited<ReturnType<typeof listOrdersAwaitingConfirmation>>["orders"][number];

function toQueueOrders(orders: QueueSourceOrder[]): ConfirmationQueueOrder[] {
  return orders.map((o) => ({
    id: o.id,
    displayNumber: displayOrderNumber(o),
    customerName: displayOrderRecipient(o),
    customerPhone: o.shippingPhone ?? o.customer.phone ?? null,
    customerWhatsapp: o.customer.whatsapp ?? null,
    city: o.shippingCity ?? o.customer.city ?? null,
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
}

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; tab?: string }>;
}) {
  const user = await requirePermission("orders.confirm");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const search = params.q?.trim() || undefined;
  const tab: TabKey = TABS.some((t) => t.key === params.tab) ? (params.tab as TabKey) : "a-confirmer";

  const [summary, stats] = await Promise.all([getConfirmationDashboardSummary(), getMyConfirmationStats(user.id)]);

  function tabHref(key: TabKey) {
    return `/confirmation?tab=${key}`;
  }

  return (
    <div>
      <PageHeader
        title="Confirmation des commandes"
        description="File d'attente partagée — appelez le client, puis enregistrez le résultat. Une commande confirmée vous est créditée."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="À confirmer" value={String(summary.toConfirm)} icon={PhoneCall} tone="primary" />
        <KpiCard label="Confirmées ce mois" value={String(summary.confirmedThisMonth)} icon={CheckCircle2} tone="success" />
        <KpiCard label="À rappeler" value={String(summary.toRecall)} icon={RotateCcw} tone="warning" />
        <KpiCard label="Aujourd'hui" value={String(summary.confirmedToday)} icon={UserCheck} tone="info" />
      </div>

      <div className="mb-4 flex flex-wrap gap-1 border-b pb-2">
        {TABS.map((t) => (
          <Button
            key={t.key}
            size="sm"
            variant={tab === t.key ? "default" : "ghost"}
            render={<Link href={tabHref(t.key)} />}
          >
            <t.icon className="size-4" />
            {t.label}
          </Button>
        ))}
      </div>

      {tab === "a-confirmer" && (
        <QueueTab search={search} page={page} onlyRetried={false} />
      )}
      {tab === "rappeler" && <QueueTab search={search} page={page} onlyRetried />}
      {tab === "confirmees" && <ConfirmedTab search={search} page={page} />}
      {tab === "mes-confirmations" && <MyConfirmationsTab userId={user.id} page={page} stats={stats} />}
    </div>
  );
}

async function QueueTab({ search, page, onlyRetried }: { search?: string; page: number; onlyRetried: boolean }) {
  const { orders, total, pageSize } = await listOrdersAwaitingConfirmation({ page, search, onlyRetried });
  const queueOrders = toQueueOrders(orders);
  const tabParam = onlyRetried ? "rappeler" : "a-confirmer";

  return (
    <div>
      <div className="mb-4">
        <FilterSearchInput paramKey="q" placeholder="N° commande, client, téléphone…" className="w-72 max-w-full" />
      </div>
      {queueOrders.length === 0 ? (
        <EmptyState
          icon={onlyRetried ? RotateCcw : PhoneCall}
          title={
            search
              ? "Aucune commande ne correspond."
              : onlyRetried
                ? "Aucune commande à rappeler."
                : "Aucune commande en attente de confirmation."
          }
        />
      ) : (
        <div className="space-y-4">
          <ConfirmationQueue orders={queueOrders} />
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/confirmation"
            searchParams={{ q: search, tab: tabParam }}
          />
        </div>
      )}
    </div>
  );
}

async function ConfirmedTab({ search, page }: { search?: string; page: number }) {
  const { orders, total, pageSize } = await listRecentlyConfirmedOrders({ page, search });
  const rows: ConfirmedOrderRow[] = orders.map((o) => ({
    id: o.id,
    displayNumber: displayOrderNumber(o),
    customerName: displayOrderRecipient(o),
    total: o.total.toString(),
    currency: o.currency,
    status: o.status,
    confirmedAt: o.confirmedAt?.toISOString() ?? null,
    agentName: o.confirmationAgent?.user.name ?? null,
  }));

  return (
    <div>
      <div className="mb-4">
        <FilterSearchInput paramKey="q" placeholder="N° commande, client, téléphone…" className="w-72 max-w-full" />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Aucune commande confirmée pour le moment." />
      ) : (
        <div className="space-y-4">
          <ConfirmedOrdersList orders={rows} showAgent />
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/confirmation"
            searchParams={{ q: search, tab: "confirmees" }}
          />
        </div>
      )}
    </div>
  );
}

async function MyConfirmationsTab({
  userId,
  page,
  stats,
}: {
  userId: string;
  page: number;
  stats: Awaited<ReturnType<typeof getMyConfirmationStats>>;
}) {
  const agentId = await getCommissionAgentIdForUser(userId);

  if (!agentId) {
    return (
      <EmptyState
        icon={UserCheck}
        title="Vous n'êtes pas enregistré comme agent de confirmation."
        description="Un manager peut vous ajouter dans le module Commissions pour suivre vos commandes ici."
      />
    );
  }

  const [pipeline, breakdown, { orders, total, pageSize }] = await Promise.all([
    getAgentOrderPipeline(agentId),
    getAgentCommissionBreakdown(agentId),
    listOrdersConfirmedByAgent(agentId, { page }),
  ]);

  const potentialCommission = stats.ratePerOrder !== null ? stats.ratePerOrder * pipeline.confirmed : null;
  const rows: ConfirmedOrderRow[] = orders.map((o) => ({
    id: o.id,
    displayNumber: displayOrderNumber(o),
    customerName: displayOrderRecipient(o),
    total: o.total.toString(),
    currency: o.currency,
    status: o.status,
    confirmedAt: o.confirmedAt?.toISOString() ?? null,
  }));
  const currency = stats.currency;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Commandes confirmées</p>
          <p className="text-2xl font-semibold">{pipeline.total}</p>
          <p className="text-xs text-muted-foreground">
            {pipeline.delivered} livrées · {pipeline.confirmed} en cours · {pipeline.returned} retournées
          </p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Commission potentielle</p>
          <p className="text-2xl font-semibold">{potentialCommission !== null ? formatCurrency(potentialCommission, currency) : "—"}</p>
          <p className="text-xs text-muted-foreground">Commandes confirmées, en attente de livraison</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Commission acquise</p>
          <p className="text-2xl font-semibold text-emerald-600 dark:text-emerald-400">
            {formatCurrency(breakdown.earnedAmount, currency)}
          </p>
          <p className="text-xs text-muted-foreground">{breakdown.reversedCount > 0 ? `${formatCurrency(breakdown.reversedAmount, currency)} reversée(s)` : "Aucune reprise"}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">Net</p>
          <p className="text-2xl font-semibold">{formatCurrency(breakdown.netAmount, currency)}</p>
          <p className="text-xs text-muted-foreground">Acquise − reversée, hors potentielle</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={UserCheck} title="Vous n'avez pas encore confirmé de commande." />
      ) : (
        <div className="space-y-4">
          <ConfirmedOrdersList orders={rows} />
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/confirmation"
            searchParams={{ tab: "mes-confirmations" }}
          />
        </div>
      )}
    </div>
  );
}
