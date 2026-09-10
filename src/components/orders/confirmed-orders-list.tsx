import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export interface ConfirmedOrderRow {
  id: string;
  displayNumber: string;
  customerName: string;
  total: string;
  currency: string;
  status: string;
  confirmedAt: string | null;
  agentName?: string | null;
}

/**
 * Read-only rows for orders that already left the confirmation queue (the
 * "Confirmées" and "Mes confirmations" tabs) — no call/outcome actions,
 * `recordConfirmationAttemptAction` only accepts NOUVELLE orders anyway.
 */
export function ConfirmedOrdersList({ orders, showAgent = false }: { orders: ConfirmedOrderRow[]; showAgent?: boolean }) {
  return (
    <div className="divide-y rounded-lg border">
      {orders.map((o) => (
        <Link
          key={o.id}
          href={`/commandes/${o.id}`}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm hover:bg-muted/50"
        >
          <div className="min-w-0">
            <span className="font-medium">{o.displayNumber}</span>
            <span className="ml-2 truncate text-muted-foreground">{o.customerName}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {showAgent && o.agentName && <span>👤 {o.agentName}</span>}
            <span className="tabular-nums">{formatCurrency(o.total, o.currency)}</span>
            <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
            <span className="whitespace-nowrap">{o.confirmedAt ? formatDateTime(o.confirmedAt) : "—"}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
