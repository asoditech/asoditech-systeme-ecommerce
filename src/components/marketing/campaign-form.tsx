"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createMarketingCampaignAction } from "@/actions/marketing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CAMPAIGN_STATUS_LABELS } from "@/lib/status-labels";
import type { MarketingChannel } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

export function CampaignForm({ channels }: { channels: MarketingChannel[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await createMarketingCampaignAction(formData);
      if (result.ok) {
        toast.success("Campagne créée.");
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
      <DialogTrigger render={<Button type="button" disabled={channels.length === 0} />}>
        <Plus className="size-4" />
        Nouvelle campagne
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nouvelle campagne marketing</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="channelId">Canal</Label>
            <Select name="channelId" required>
              <SelectTrigger id="channelId" className="w-full">
                <SelectValue placeholder="Choisir un canal">
                  {(value: string) => channels.find((c) => c.id === value)?.name ?? "Choisir un canal"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="name">Nom de la campagne</Label>
            <Input id="name" name="name" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="startDate">Date de début</Label>
              <Input id="startDate" name="startDate" type="date" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="endDate">Date de fin</Label>
              <Input id="endDate" name="endDate" type="date" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="budget">Budget (MAD)</Label>
              <Input id="budget" name="budget" type="number" step="0.01" min="0" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="spend">Dépense actuelle (MAD)</Label>
              <Input id="spend" name="spend" type="number" step="0.01" min="0" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="status">Statut</Label>
            <Select name="status" defaultValue="BROUILLON">
              <SelectTrigger id="status" className="w-full">
                <SelectValue>{(value: string) => CAMPAIGN_STATUS_LABELS[value]?.label ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CAMPAIGN_STATUS_LABELS).map(([value, meta]) => (
                  <SelectItem key={value} value={value}>
                    {meta.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" rows={2} />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Création..." : "Créer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
