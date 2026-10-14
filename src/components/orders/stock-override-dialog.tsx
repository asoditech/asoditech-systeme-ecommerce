"use client";

import { useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { STOCK_OVERRIDE_REASON_LIMITS, type StockShortage } from "@/lib/stock-shortage";
import { Textarea } from "@/components/ui/textarea";

/**
 * P2 — a confirmation was refused for stock. Lists exactly the rows the server
 * reported; an OWNER / ADMIN / MANAGER (server says `canOverride`) may confirm
 * anyway with a mandatory reason — the override covers ONLY these rows, every
 * other line stays strictly checked, and the server re-verifies everything.
 * Others are told to ask a manager. One submission per dialog instance — the
 * parent remounts it for each new refusal (`key={shortage.token}`).
 */
export function StockOverrideDialog({
  shortage,
  pending,
  onCancel,
  onOverride,
}: {
  shortage: StockShortage | null;
  pending: boolean;
  onCancel: () => void;
  onOverride: (token: string, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const submitted = useRef(false);
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= STOCK_OVERRIDE_REASON_LIMITS.min && trimmed.length <= STOCK_OVERRIDE_REASON_LIMITS.max;
  const canSubmit = Boolean(shortage?.canOverride && shortage.token) && reasonOk && !pending;

  function close() {
    setReason("");
    onCancel();
  }
  function confirm() {
    // A double click (or Enter + click) submits once: the flag never resets
    // for this instance.
    if (submitted.current || !canSubmit || !shortage?.token) return;
    submitted.current = true;
    onOverride(shortage.token, trimmed);
  }

  return (
    <AlertDialog open={shortage !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stock insuffisant</AlertDialogTitle>
          <AlertDialogDescription>
            La commande n&apos;a pas été confirmée : le stock disponible de l&apos;emplacement de préparation ne couvre pas
            ces lignes. Rien n&apos;a été réservé ni modifié.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1 rounded-tile bg-pill-neutral p-3.5 text-sm">
          {shortage?.lines.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
        {shortage?.canOverride ? (
          <div className="space-y-1.5">
            <Label htmlFor="stock-override-reason">Motif de la confirmation malgré la rupture</Label>
            <Textarea
              id="stock-override-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={STOCK_OVERRIDE_REASON_LIMITS.max}
              rows={3}
              placeholder="Ex. : réassort fournisseur attendu demain"
            />
            <p className="text-xs text-muted-foreground">
              La réservation dépassera le stock uniquement pour les lignes ci-dessus ; les autres lignes restent
              contrôlées. Ce choix est enregistré dans le journal d&apos;audit ({STOCK_OVERRIDE_REASON_LIMITS.min} à{" "}
              {STOCK_OVERRIDE_REASON_LIMITS.max} caractères).
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Seul un responsable, un administrateur ou le propriétaire peut confirmer malgré une rupture de stock.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" onClick={close}>
            Fermer
          </AlertDialogCancel>
          {shortage?.canOverride && (
            <AlertDialogAction type="button" variant="destructive" disabled={!canSubmit} onClick={confirm}>
              Confirmer malgré la rupture
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
