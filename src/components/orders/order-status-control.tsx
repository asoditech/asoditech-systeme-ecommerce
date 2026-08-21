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
import type { OrderPaymentStatus } from "@prisma/client";

export function OrderStatusControl({
  orderId,
  currentStatus,
  canEdit,
}: {
  orderId: string;
  currentStatus: OrderStatusValue;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pendingStatus, setPendingStatus] = React.useState<OrderStatusValue | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const nextStatuses = ORDER_STATUS_TRANSITIONS[currentStatus];

  function confirmChange() {
    if (!pendingStatus) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", orderId);
      formData.set("status", pendingStatus);
      const result = await updateOrderStatusAction(formData);
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
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={confirmChange} disabled={isPending}>
              {isPending ? "En cours..." : "Confirmer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        {Object.entries(ORDER_PAYMENT_STATUS_LABELS).map(([value, meta]) => (
          <SelectItem key={value} value={value}>
            {meta.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
