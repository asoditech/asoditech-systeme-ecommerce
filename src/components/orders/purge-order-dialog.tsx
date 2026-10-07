"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { History, Trash2, TriangleAlert, UserRound } from "lucide-react";
import { previewOrderPurgeAction, purgeTestOrderAction } from "@/actions/order-purge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PurgeEvaluation } from "@/lib/orders/purge";
import { PURGE_MIN_REASON, purgeConfirmationReady, purgeOutcome } from "@/lib/orders/purge-ui";

/**
 * Short screens: the popup itself never scrolls — header and footer stay put
 * and only the body scrolls — so the footer (a sticky overlay in the shared
 * DialogFooter) can never sit on top of the order-number field.
 */
export const PURGE_DIALOG_CONTENT_CLASS = "flex max-h-[92dvh] flex-col overflow-hidden sm:max-w-lg";
export const PURGE_DIALOG_BODY_CLASS = "-mx-6 min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-1";
export const PURGE_DIALOG_FOOTER_CLASS = "static shrink-0";

export interface PurgeOrderSummary {
  orderId: string;
  /** The displayed number, e.g. CMD-000123 — the one the user must retype. */
  orderLabel: string;
  statusLabel: string;
  customerName: string;
  total: string;
  lines: { name: string; sku: string; quantity: number }[];
}

/**
 * « Purger cette commande de test » — a deliberate, separate action (not
 * « Annuler »). The page only renders it for an `orders.purge` holder and an
 * eligible order; the dialog refreshes the server preview on open and the
 * purge itself is the existing server action, which re-checks everything.
 */
export function PurgeOrderButton({ summary, initialEvaluation }: { summary: PurgeOrderSummary; initialEvaluation: PurgeEvaluation }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
        Purger cette commande de test
      </Button>
      <PurgeOrderDialog open={open} onOpenChange={setOpen} summary={summary} initialEvaluation={initialEvaluation} after="redirect" />
    </>
  );
}

/**
 * The purge dialog itself, controlled — opened by the detail page's button or
 * by the orders table's row menu. Same server preview + same purge action in
 * both places. Without `initialEvaluation` (the table: no per-row preview is
 * computed) the preview is loaded when the dialog opens and the confirm stays
 * disabled until it arrives. `after`: "redirect" leaves the deleted order's
 * page for /commandes; "refresh" re-renders the current list.
 */
export function PurgeOrderDialog({
  open,
  onOpenChange,
  summary,
  initialEvaluation = null,
  after,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: PurgeOrderSummary;
  initialEvaluation?: PurgeEvaluation | null;
  after: "redirect" | "refresh";
}) {
  const router = useRouter();
  const [evaluation, setEvaluation] = useState<PurgeEvaluation | null>(initialEvaluation);
  const [reason, setReason] = useState("");
  const [typedNumber, setTypedNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [wasOpen, setWasOpen] = useState(false);

  // Each opening starts clean (state adjusted during render on an `open`
  // change — React's documented pattern) …
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setReason("");
      setTypedNumber("");
      setError(null);
    }
  }
  // … and refreshes the server preview: the order may have changed since the
  // page was rendered.
  useEffect(() => {
    if (!open) return;
    startTransition(async () => {
      const r = await previewOrderPurgeAction(summary.orderId);
      if (r.ok) setEvaluation(r.data);
      else setError(r.error);
    });
  }, [open, summary.orderId]);

  function confirm() {
    startTransition(async () => {
      const outcome = purgeOutcome(await purgeTestOrderAction({ orderId: summary.orderId, reason }));
      if (outcome.kind === "success") {
        toast.success(outcome.message);
        onOpenChange(false);
        if (after === "redirect") router.replace(outcome.redirectTo); // never stay on the deleted order's URL
        else router.refresh();
      } else {
        setError(outcome.message);
        toast.error(outcome.message);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={PURGE_DIALOG_CONTENT_CLASS}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="size-4" />
            Purger cette commande de test
          </DialogTitle>
          <DialogDescription>
            Réservé aux commandes de test jamais expédiées. Pour une vraie commande, utilisez « Annuler ».
          </DialogDescription>
        </DialogHeader>
        <PurgeDialogBody>
          {evaluation ? (
            <PurgeOrderPanel
              summary={summary}
              evaluation={evaluation}
              reason={reason}
              typedNumber={typedNumber}
              error={error}
              pending={isPending}
              onReasonChange={setReason}
              onTypedNumberChange={setTypedNumber}
            />
          ) : (
            <p role="status" className="py-6 text-center text-sm text-muted-foreground">
              {error ?? "Vérification de la commande…"}
            </p>
          )}
        </PurgeDialogBody>
        <DialogFooter className={PURGE_DIALOG_FOOTER_CLASS}>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Fermer
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirm}
            disabled={
              isPending ||
              !evaluation ||
              !purgeConfirmationReady({ reason, typedNumber, orderLabel: summary.orderLabel, eligible: evaluation.eligible })
            }
          >
            {isPending ? "En cours..." : "Purger définitivement"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's independently scrolling region (between the fixed header and footer). */
export function PurgeDialogBody({ children }: { children: React.ReactNode }) {
  return (
    <div data-slot="purge-dialog-body" className={PURGE_DIALOG_BODY_CLASS}>
      {children}
    </div>
  );
}

/** The dialog body — presentational (tested by static render). */
export function PurgeOrderPanel({
  summary,
  evaluation,
  reason,
  typedNumber,
  error,
  pending = false,
  onReasonChange,
  onTypedNumberChange,
}: {
  summary: PurgeOrderSummary;
  evaluation: PurgeEvaluation;
  reason: string;
  typedNumber: string;
  error: string | null;
  pending?: boolean;
  onReasonChange?: (v: string) => void;
  onTypedNumberChange?: (v: string) => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/30 px-3 py-2.5">
        <dt className="text-muted-foreground">Commande</dt>
        <dd className="text-right font-semibold">{summary.orderLabel}</dd>
        <dt className="text-muted-foreground">Statut</dt>
        <dd className="text-right">{summary.statusLabel}</dd>
        <dt className="text-muted-foreground">Client</dt>
        <dd className="truncate text-right">{summary.customerName}</dd>
        <dt className="text-muted-foreground">Total</dt>
        <dd className="text-right tabular-nums">{summary.total}</dd>
      </dl>

      <div>
        <p className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Articles</p>
        <ul className="divide-y rounded-lg border">
          {summary.lines.map((l, i) => (
            <li key={`${l.sku}-${i}`} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="min-w-0 truncate">
                {l.name} <span className="font-mono text-xs text-muted-foreground">{l.sku}</span>
              </span>
              <span className="shrink-0 tabular-nums">×{l.quantity}</span>
            </li>
          ))}
        </ul>
      </div>

      {evaluation.eligible ? (
        <ul className="space-y-1.5 text-xs">
          {evaluation.preview.releaseReservation ? (
            <li>
              <span className="font-medium">Stock réservé libéré :</span>{" "}
              {evaluation.preview.releasedLines.map((l) => `${l.name} ×${l.quantity}`).join(", ")}.
            </li>
          ) : (
            <li className="text-muted-foreground">Aucun stock réservé à libérer.</li>
          )}
          {evaluation.preview.failedShipmentIds.length > 0 && (
            <li>
              <span className="font-medium">Tentatives d&apos;expédition en échec supprimées :</span>{" "}
              {evaluation.preview.failedShipmentIds.length} (aucun colis chez le transporteur).
            </li>
          )}
          <li className="flex items-start gap-1.5 text-muted-foreground">
            <History className="mt-0.5 size-3.5 shrink-0" />
            Les mouvements de stock et l&apos;historique (journal d&apos;audit) sont conservés.
          </li>
          <li className="flex items-start gap-1.5 text-muted-foreground">
            <UserRound className="mt-0.5 size-3.5 shrink-0" />
            Le client est conservé.
          </li>
        </ul>
      ) : (
        <div role="alert" className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-destructive">
          <p className="font-medium">Cette commande ne peut pas être purgée :</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {evaluation.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2.5 font-medium text-destructive">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        Cette action supprime définitivement la commande. Elle ne peut pas être annulée.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="purge-reason">Motif (obligatoire)</Label>
        <Textarea
          id="purge-reason"
          rows={2}
          value={reason}
          disabled={pending || !evaluation.eligible}
          onChange={(e) => onReasonChange?.(e.target.value)}
          placeholder="Ex. : commande créée pour tester la boutique"
        />
        {reason.length > 0 && reason.trim().length < PURGE_MIN_REASON && (
          <p className="text-xs text-muted-foreground">Au moins {PURGE_MIN_REASON} caractères.</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="purge-confirm-number">
          Tapez <span className="font-mono font-semibold">{summary.orderLabel}</span> pour confirmer
        </Label>
        <Input
          id="purge-confirm-number"
          value={typedNumber}
          autoComplete="off"
          disabled={pending || !evaluation.eligible}
          onChange={(e) => onTypedNumberChange?.(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
