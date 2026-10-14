"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateOrderStatusAction, updateOrderPaymentStatusAction } from "@/actions/orders";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { ORDER_STATUS_TRANSITIONS, type OrderStatusValue } from "@/lib/validation/order";
import { ORDER_STATUS_LABELS, ORDER_PAYMENT_STATUS_LABELS } from "@/lib/status-labels";
import { StatusBadge } from "@/components/status-badge";
import { StockOverrideDialog } from "@/components/orders/stock-override-dialog";
import { confirmationStockNotice, stockShortageOf, type ConfirmationStockFlags, type StockShortage } from "@/lib/stock-shortage";
import type { OrderPaymentStatus } from "@prisma/client";
import { Notice } from "@/components/ui/notice";

export function OrderStatusControl({
  orderId,
  currentStatus,
  canEdit,
  stockFlags,
  hiddenStatuses = [],
}: {
  orderId: string;
  currentStatus: OrderStatusValue;
  canEdit: boolean;
  /** Transitions not offered for this order (`hiddenOrderStatusOptions`) — the server still enforces its own rules. */
  hiddenStatuses?: OrderStatusValue[];
  /** P2: stock situation at the fulfilment warehouse, shown before « → Confirmée ». */
  stockFlags?: ConfirmationStockFlags | null;
}) {
  const router = useRouter();
  const [pendingStatus, setPendingStatus] = React.useState<OrderStatusValue | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const nextStatuses = ORDER_STATUS_TRANSITIONS[currentStatus].filter((s) => !hiddenStatuses.includes(s));
  // P2: a → « Confirmée » refused for stock opens the shortage / override dialog.
  const [shortage, setShortage] = React.useState<StockShortage | null>(null);

  function confirmChange(statusArg?: OrderStatusValue, override?: { token: string; reason: string }) {
    const target = statusArg ?? pendingStatus;
    if (!target) return;
    setShortage(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", orderId);
      formData.set("status", target);
      if (override) {
        formData.set("stockOverrideToken", override.token);
        formData.set("stockOverrideReason", override.reason);
      }
      const result = await updateOrderStatusAction(formData);
      const refusedForStock = stockShortageOf(result);
      if (refusedForStock) {
        setPendingStatus(null);
        setShortage(refusedForStock);
        return;
      }
      if (result.ok) {
        toast.success("Statut mis à jour.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
      setPendingStatus(null);
    });
  }

  if (!canEdit || nextStatuses.length === 0) return null;

  return (
    <>
      <Select value="" onValueChange={(v) => setPendingStatus(v as OrderStatusValue)}>
        <SelectTrigger className="w-56">
          <SelectValue placeholder="Changer le statut..." />
        </SelectTrigger>
        <SelectContent>
          {nextStatuses.map((s) => (
            <SelectItem key={s} value={s}>
              {ORDER_STATUS_LABELS[s].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <AlertDialog open={pendingStatus !== null} onOpenChange={(open) => !open && setPendingStatus(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer le changement de statut</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingStatus &&
                `Passer la commande de "${ORDER_STATUS_LABELS[currentStatus].label}" à "${ORDER_STATUS_LABELS[pendingStatus].label}" ?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingStatus === "CONFIRMEE" &&
            confirmationStockNotice(stockFlags).map((line) => (
              <Notice key={line} tone="warning" size="sm">
                {line}
              </Notice>
            ))}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={() => confirmChange()} disabled={isPending}>
              {isPending ? "En cours..." : "Confirmer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <StockOverrideDialog
        key={shortage?.token ?? "none"}
        shortage={shortage}
        pending={isPending}
        onCancel={() => setShortage(null)}
        onOverride={(token, reason) => confirmChange("CONFIRMEE", { token, reason })}
      />
    </>
  );
}

export function OrderPaymentStatusControl({
  orderId,
  currentPaymentStatus,
  canEdit,
}: {
  orderId: string;
  currentPaymentStatus: OrderPaymentStatus;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();

  if (!canEdit) return null;

  // REMBOURSE is derived — only set by completing a Refund (see
  // updateOrderPaymentStatusAction, which now rejects it as a direct
  // target). Once an order is refunded, show it as a fixed badge rather
  // than an editable control that would just error on every option.
  if (currentPaymentStatus === "REMBOURSE") {
    return <StatusBadge status={currentPaymentStatus} labels={ORDER_PAYMENT_STATUS_LABELS} />;
  }

  const selectableStatuses = Object.entries(ORDER_PAYMENT_STATUS_LABELS).filter(([value]) => value !== "REMBOURSE");

  return (
    <Select
      value={currentPaymentStatus}
      onValueChange={(value) => {
        if (!value) return;
        startTransition(async () => {
          const formData = new FormData();
          formData.set("id", orderId);
          formData.set("paymentStatus", value);
          const result = await updateOrderPaymentStatusAction(formData);
          if (result.ok) {
            toast.success("Statut de paiement mis à jour.");
            router.refresh();
          } else {
            toast.error(result.error);
          }
        });
      }}
      disabled={isPending}
    >
      <SelectTrigger className="w-52">
        <SelectValue>{(value: string) => ORDER_PAYMENT_STATUS_LABELS[value]?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {selectableStatuses.map(([value, meta]) => (
          <SelectItem key={value} value={value}>
            {meta.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
