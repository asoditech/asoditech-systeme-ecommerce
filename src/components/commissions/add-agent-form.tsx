"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { createCommissionAgentAction } from "@/actions/commissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ActionResult, IdResult } from "@/actions/types";

export function AddAgentForm({ users }: { users: { id: string; name: string }[] }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await createCommissionAgentAction(formData);
      if (result.ok) {
        toast.success("Agent de confirmation ajouté.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  if (users.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Tous les utilisateurs actifs sont déjà des agents. Créez un utilisateur pour en ajouter un.
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="agent-user">Utilisateur</Label>
        <Select name="userId" required>
          <SelectTrigger id="agent-user" className="w-56">
            <SelectValue placeholder="Choisir un utilisateur">
              {(value: string) => users.find((u) => u.id === value)?.name ?? "Choisir un utilisateur"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="agent-rate">Commission par commande livrée (MAD)</Label>
        <Input id="agent-rate" name="ratePerOrder" type="number" step="0.5" min="0" defaultValue="10" className="w-52" />
      </div>
      <Button type="submit" disabled={isPending}>
        <UserPlus className="size-4" />
        {isPending ? "Ajout…" : "Ajouter l'agent"}
      </Button>
      {state && !state.ok && <p className="w-full text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
