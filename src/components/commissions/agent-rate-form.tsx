"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateCommissionAgentAction } from "@/actions/commissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult, IdResult } from "@/actions/types";

export function AgentRateForm({
  agentId,
  ratePerOrder,
  isActive,
}: {
  agentId: string;
  ratePerOrder: number;
  isActive: boolean;
}) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await updateCommissionAgentAction(formData);
      if (result.ok) {
        toast.success("Agent mis à jour.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3 sm:flex-nowrap">
      <input type="hidden" name="agentId" value={agentId} />
      <div className="shrink-0 space-y-1.5">
        <Label htmlFor={`rate-${agentId}`}>Commission par commande livrée (MAD)</Label>
        <Input
          id={`rate-${agentId}`}
          name="ratePerOrder"
          type="number"
          step="0.5"
          min="0"
          defaultValue={ratePerOrder}
          className="w-44"
        />
        <p className="text-xs text-muted-foreground">Les commissions déjà calculées gardent leur ancien taux.</p>
      </div>
      <label className="flex shrink-0 items-center gap-2 pb-1.5 text-sm">
        <input type="checkbox" name="isActive" value="true" defaultChecked={isActive} className="size-4" />
        Actif (peut recevoir de nouvelles commandes)
      </label>
      <Button type="submit" variant="outline" disabled={isPending} className="shrink-0">
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>
      {state && !state.ok && <p className="w-full text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
