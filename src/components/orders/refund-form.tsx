"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createRefundAction } from "@/actions/orders";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * `maxAmount` = order total minus every refund not rejected (pending,
 * approved, complete) — the same cap createRefundAction enforces; `currency`
 * = the order's own currency (never assumed MAD).
 */
export function RefundForm({ orderId, maxAmount, currency }: { orderId: string; maxAmount: number; currency: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await createRefundAction(formData);
      if (result.ok) {
        toast.success("Remboursement enregistré.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Enregistrer un remboursement
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="orderId" value={orderId} />
          <div className="space-y-1.5">
            <Label htmlFor="amount">
              Montant (max {maxAmount.toFixed(2)} {currency})
            </Label>
            <Input id="amount" name="amount" type="number" step="0.01" min="0" max={maxAmount} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Motif</Label>
            <Textarea id="reason" name="reason" rows={2} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
