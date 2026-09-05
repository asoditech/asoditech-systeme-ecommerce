"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { setCustomerBlacklistAction } from "@/actions/customers";
import { Button } from "@/components/ui/button";
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
import { ConfirmActionButton } from "@/components/confirm-action-button";
import type { ActionResult } from "@/actions/types";
import type { Customer } from "@prisma/client";

/**
 * Toggles Customer.isBlacklisted — always a deliberate human decision
 * (see the field's own doc comment), never automatic. Blacklisting asks
 * for an optional reason (shown back wherever the flag is surfaced);
 * removing it is a plain confirmation.
 */
export function CustomerBlacklistControl({ customerId, isBlacklisted }: { customerId: string; isBlacklisted: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<Customer> | undefined, formData: FormData) => setCustomerBlacklistAction(formData),
    undefined
  );

  if (state?.ok && open) {
    setOpen(false);
    toast.success("Client marqué comme indésirable.");
    router.refresh();
  }

  if (isBlacklisted) {
    return (
      <ConfirmActionButton
        label="Retirer de la liste indésirable"
        variant="ghost"
        title="Retirer ce client de la liste indésirable ?"
        description="Le client ne sera plus signalé comme indésirable dans ce projet."
        hiddenFields={{ id: customerId, blacklisted: "false" }}
        action={setCustomerBlacklistAction}
        successMessage="Client retiré de la liste indésirable."
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <ShieldAlert className="size-4" />
        Marquer comme indésirable
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marquer ce client comme indésirable</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="id" value={customerId} />
          <input type="hidden" name="blacklisted" value="true" />
          <div className="space-y-1.5">
            <Label htmlFor="reason">Motif (optionnel)</Label>
            <Textarea id="reason" name="reason" rows={3} placeholder="Ex. : 3 commandes annulées sans explication" />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="destructive" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Marquer comme indésirable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
