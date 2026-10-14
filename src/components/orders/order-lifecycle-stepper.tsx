import { formatDate } from "@/lib/format";
import type { OrderStatus } from "@prisma/client";

export type OrderCommissionStatus = "none" | "pending" | "earned" | "reversed";

interface Step {
  key: string;
  label: string;
  date: Date | null;
}

/**
 * Compact horizontal lifecycle stepper — a UI representation only. The
 * source of truth stays the order's status/timestamps, the confirmation
 * attempts and the commission ledger; this just renders what's already
 * been fetched, it computes nothing new.
 */
export function OrderLifecycleStepper({
  status,
  placedAt,
  confirmedAt,
  shippedAt,
  deliveredAt,
  cancelledAt,
  confirmationAgentName,
  commissionStatus,
}: {
  status: OrderStatus;
  placedAt: Date;
  confirmedAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  confirmationAgentName?: string | null;
  commissionStatus: OrderCommissionStatus;
}) {
  const isCancelled = status === "ANNULEE" || status === "ECHEC";
  const isReturned = status === "RETOUR" || status === "REMBOURSEE";

  const steps: Step[] = isCancelled
    ? [
        { key: "NOUVELLE", label: "Nouvelle", date: placedAt },
        { key: status, label: status === "ECHEC" ? "Échec" : "Annulée", date: cancelledAt },
      ]
    : isReturned
      ? [
          { key: "NOUVELLE", label: "Nouvelle", date: placedAt },
          { key: "CONFIRMEE", label: "Confirmée", date: confirmedAt },
          { key: "EXPEDIEE", label: "Expédiée", date: shippedAt },
          { key: "LIVREE", label: "Livrée", date: deliveredAt },
          { key: status, label: status === "REMBOURSEE" ? "Remboursée" : "Retour", date: null },
        ]
      : [
          { key: "NOUVELLE", label: "Nouvelle", date: placedAt },
          { key: "CONFIRMEE", label: "Confirmée", date: confirmedAt },
          { key: "EN_PREPARATION", label: "Emballage", date: null },
          { key: "EXPEDIEE", label: "Expédiée", date: shippedAt },
          { key: "LIVREE", label: "Livrée", date: deliveredAt },
        ];

  const currentIdx = steps.findIndex((s) => s.key === status);

  return (
    <div className="flex items-start overflow-x-auto pb-1">
      {steps.map((step, i) => {
        const reached = currentIdx === -1 || i <= currentIdx;
        const isLast = i === steps.length - 1;
        const showCommissionChip =
          isLast && reached && (commissionStatus === "earned" || commissionStatus === "reversed");
        return (
          <div key={step.key} className={`flex items-start ${isLast ? "" : "flex-1"}`}>
            <div className="flex min-w-[88px] flex-col items-center gap-1 text-center">
              <span
                className={`size-3 shrink-0 rounded-full ring-4 ${
                  reached ? "bg-brand ring-pill-peach" : "bg-field-border ring-transparent"
                }`}
                aria-hidden="true"
              />
              <span className={`mt-1 text-xs font-medium whitespace-nowrap ${reached ? "text-ink" : "text-ink-muted"}`}>
                {step.label}
              </span>
              {step.date && <span className="text-[11px] whitespace-nowrap text-ink-muted tabular-nums">{formatDate(step.date)}</span>}
              {step.key === "CONFIRMEE" && reached && confirmationAgentName && (
                <span className="text-[11px] whitespace-nowrap text-ink-muted">{confirmationAgentName}</span>
              )}
              {showCommissionChip && (
                <span
                  className={`text-[11px] font-medium whitespace-nowrap ${
                    commissionStatus === "earned" ? "text-pill-green-fg" : "text-pill-red-fg"
                  }`}
                >
                  {commissionStatus === "earned" ? "💰 Commission acquise" : "↩ Commission reversée"}
                </span>
              )}
            </div>
            {!isLast && (
              <span className={`mt-[5px] h-0.5 min-w-6 flex-1 rounded-full ${i < currentIdx ? "bg-brand" : "bg-field-border"}`} aria-hidden="true" />
            )}
          </div>
        );
      })}
    </div>
  );
}
