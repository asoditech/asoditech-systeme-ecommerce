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
    <form action={formAction} className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="agent-user" className="whitespace-nowrap">Utilisateur</Label>
          <Select name="userId" required>
            <SelectTrigger id="agent-user" className="w-full">
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
        <div className="flex-1 space-y-1.5">
          {/* nowrap: at reduced width this label wrapping to 2 lines while
              "Utilisateur" stays 1 line threw the two inputs out of vertical
              alignment — the row itself never wraps (no flex-wrap), only
              this label did, so fixing this alone fixes the décalage. */}
          <Label htmlFor="agent-rate" className="whitespace-nowrap">Taux / commande livrée</Label>
          <Input id="agent-rate" name="ratePerOrder" type="number" step="0.5" min="0" defaultValue="10" className="w-full" />
        </div>
        {/* `items-start` (not `items-end`) because Select's hidden native
            <select>/<input> sibling (rendered after SelectTrigger for form
            submission/accessibility) picks up its own space-y-1.5 top
            margin, inflating that column's total height beyond the plain
            Input column's — bottom-aligning the two then left the shorter
            (Input) column's visible label+control sitting lower than the
            Select's. Top-aligning is immune to that trailing, invisible
            height difference. The Button has no label above it, so an
            invisible one (exact same component, just hidden) keeps its
            control starting at the same Y as the two labeled fields'. */}
        <div className="space-y-1.5">
          <Label aria-hidden className="text-transparent select-none">Ajouter</Label>
          <Button type="submit" disabled={isPending} className="shrink-0">
            <UserPlus className="size-4" />
            {isPending ? "Ajout…" : "Ajouter"}
          </Button>
        </div>
      </div>
      {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
