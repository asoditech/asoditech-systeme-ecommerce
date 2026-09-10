"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Flag } from "lucide-react";
import { reportProblemAction } from "@/actions/support";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SUPPORT_TICKET_CATEGORIES } from "@/lib/validation/support";
import type { SupportContext } from "@/lib/support/context";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * "Signaler un problème" — a light report form, not a ticketing UI. It
 * captures a category, a description and the current page/record context,
 * then hands off to `reportProblemAction` (persists a SupportTicket,
 * notifies admins, forwards to the configured support email).
 */
export function ReportProblemDialog({
  context,
  pageUrl,
}: {
  context: SupportContext;
  pageUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await reportProblemAction(formData);
      if (result.ok) {
        toast.success("Merci, votre signalement a été transmis au support.");
        setOpen(false);
      }
      return result;
    },
    undefined,
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          />
        }
      >
        <Flag className="size-4 text-amber-600 dark:text-amber-400" />
        Signaler un problème
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Signaler un problème</DialogTitle>
          <DialogDescription>
            Décrivez ce qui ne va pas. Nous joignons automatiquement l&apos;écran où vous vous trouvez.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="space-y-3">
          <input type="hidden" name="pageUrl" value={pageUrl ?? ""} />
          <input type="hidden" name="contextType" value={context.entity?.type ?? ""} />
          <input type="hidden" name="contextId" value={context.entity?.id ?? ""} />

          <div className="space-y-1.5">
            <Label htmlFor="support-category">Catégorie</Label>
            <Select name="category" defaultValue={context.reportCategory}>
              <SelectTrigger id="support-category" className="w-full">
                <SelectValue>
                  {(value: string) =>
                    SUPPORT_TICKET_CATEGORIES[value as keyof typeof SUPPORT_TICKET_CATEGORIES] ?? value
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SUPPORT_TICKET_CATEGORIES).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="support-description">Description</Label>
            <Textarea
              id="support-description"
              name="description"
              rows={4}
              required
              minLength={10}
              maxLength={2000}
              placeholder="Ex. : le total de la commande affiché ne correspond pas au montant encaissé."
            />
            {state && !state.ok && state.fieldErrors?.description && (
              <p className="text-xs text-destructive">{state.fieldErrors.description[0]}</p>
            )}
          </div>

          {context.entity && (
            <p className="text-[11px] text-muted-foreground">
              Contexte joint : {context.entity.type === "Order" ? "commande" : "expédition"} {context.entity.id}
            </p>
          )}

          {state && !state.ok && !state.fieldErrors && <p className="text-sm text-destructive">{state.error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Envoi..." : "Envoyer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
