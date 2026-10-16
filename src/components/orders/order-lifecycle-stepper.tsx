import { formatDate } from "@/lib/format";
import type { OrderStatus } from "@prisma/client";
import { ScrollFade } from "@/components/ui/scroll-fade";

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

  // Phone (< sm): a vertical list — dot + connector on the left, label and
  // date beside it — so every step is visible at 390px. From sm up: the
  // compact horizontal stepper; if it still does not fit (long agent name,
  // commission chip) the ScrollFade shows which edge hides a step.
  return (
    <ScrollFade label="Étapes de la commande" className="sm:pb-1">
      <ol data-slot="order-lifecycle" aria-label="Étapes de la commande" className="flex flex-col sm:flex-row sm:items-start">
        {steps.map((step, i) => {
          const reached = currentIdx === -1 || i <= currentIdx;
          const isLast = i === steps.length - 1;
          const showCommissionChip =
            isLast && reached && (commissionStatus === "earned" || commissionStatus === "reversed");
          return (
            <li
              key={step.key}
              aria-current={i === currentIdx ? "step" : undefined}
              className={`relative flex items-start ${isLast ? "" : "pb-4 sm:flex-1 sm:pb-0"}`}
            >
              <div className="flex min-w-0 items-start gap-3 sm:min-w-[88px] sm:flex-col sm:items-center sm:gap-1 sm:text-center">
                <span
                  className={`mt-1 size-3 shrink-0 rounded-full ring-4 sm:mt-0 ${
                    reached ? "bg-brand ring-pill-peach" : "bg-field-border ring-transparent"
                  }`}
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-col sm:items-center sm:gap-1">
                  <span className={`text-sm font-medium sm:mt-1 sm:text-xs sm:whitespace-nowrap ${reached ? "text-ink" : "text-ink-muted"}`}>
                    {step.label}
                  </span>
                  {step.date && <span className="text-[11px] whitespace-nowrap text-ink-muted tabular-nums">{formatDate(step.date)}</span>}
                  {step.key === "CONFIRMEE" && reached && confirmationAgentName && (
                    <span className="truncate text-[11px] text-ink-muted sm:whitespace-nowrap">{confirmationAgentName}</span>
                  )}
                  {showCommissionChip && (
                    <span
                      className={`text-[11px] font-medium sm:whitespace-nowrap ${
                        commissionStatus === "earned" ? "text-pill-green-fg" : "text-pill-red-fg"
                      }`}
                    >
                      {commissionStatus === "earned" ? "💰 Commission acquise" : "↩ Commission reversée"}
                    </span>
                  )}
                </div>
              </div>
              {!isLast && (
                <span
                  className={`absolute top-5 bottom-1 left-[5px] w-0.5 rounded-full sm:static sm:mt-[5px] sm:h-0.5 sm:w-auto sm:min-w-6 sm:flex-1 ${
                    i < currentIdx ? "bg-brand" : "bg-field-border"
                  }`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </ScrollFade>
  );
}
