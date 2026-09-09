"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { overrideShipmentCostAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * Explicit accounting correction of a shipment's recorded cost (docs/adr/
 * 0032 §7). `finance.manage` only — this is NOT how a normal delivery
 * price is set (that's the carrier's API) and NOT a fallback for a missing
 * one. Every use is audited with a mandatory reason.
 */
export function OverrideShipmentCostDialog({
  shipmentId,
  currentCost,
}: {
  shipmentId: string;
  currentCost: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await overrideShipmentCostAction(formData);
      if (result.ok) {
        toast.success("Coût corrigé.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="xs" variant="ghost" />}>
        <Pencil className="size-3.5" />
        Corriger le coût
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Corriger le coût de l&apos;expédition</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="id" value={shipmentId} />
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Correction comptable exceptionnelle. Le coût normal d&apos;une livraison réussie vient de l&apos;API du
            transporteur — n&apos;utilisez ceci que pour rectifier une facture. Enregistré dans le journal d&apos;audit.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="osc-cost">Coût réel (MAD)</Label>
            <Input
              id="osc-cost"
              name="cost"
              type="number"
              step="0.01"
              min="0"
              required
              defaultValue={currentCost ?? ""}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="osc-reason">Motif</Label>
            <Textarea id="osc-reason" name="reason" rows={2} required placeholder="ex. facture transporteur reçue" />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={isPending}>
              {isPending ? "Enregistrement…" : "Corriger"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
