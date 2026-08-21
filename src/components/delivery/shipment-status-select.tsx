"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateShipmentStatusAction } from "@/actions/delivery";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SHIPMENT_STATUS_TRANSITIONS, type ShipmentStatusValue } from "@/lib/validation/delivery";
import { SHIPMENT_STATUS_LABELS } from "@/lib/status-labels";

export function ShipmentStatusSelect({ shipmentId, currentStatus }: { shipmentId: string; currentStatus: ShipmentStatusValue }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(currentStatus);
  const options = [currentStatus, ...SHIPMENT_STATUS_TRANSITIONS[currentStatus]];

  return (
    <Select
      value={value}
      disabled={isPending || SHIPMENT_STATUS_TRANSITIONS[currentStatus].length === 0}
      onValueChange={(next) => {
        if (!next || next === currentStatus) return;
        setValue(next as ShipmentStatusValue);
        startTransition(async () => {
          const formData = new FormData();
          formData.set("id", shipmentId);
          formData.set("status", next);
          const result = await updateShipmentStatusAction(formData);
          if (result.ok) {
            toast.success("Statut de livraison mis à jour.");
            router.refresh();
          } else {
            toast.error(result.error);
            setValue(currentStatus);
          }
        });
      }}
    >
      <SelectTrigger className="w-44">
        <SelectValue>{(value: string) => SHIPMENT_STATUS_LABELS[value]?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((s) => (
          <SelectItem key={s} value={s}>
            {SHIPMENT_STATUS_LABELS[s].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
