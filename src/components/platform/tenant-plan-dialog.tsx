"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings2 } from "lucide-react";
import { changeTenantPlanAction, updateSubscriptionStatusAction, previewTenantPlanChange } from "@/actions/plans";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatNumber } from "@/lib/format";
import { PLAN_CODE_LABELS, SUBSCRIPTION_STATUS_LABELS } from "@/lib/status-labels";
import type { PlanCode, SubscriptionStatus } from "@prisma/client";

/**
 * Platform-only plan/subscription control (docs/adr/0035 "Platform plan
 * control") — every mutation here goes through `requirePlatformAdminForAction`
 * server-side; a normal tenant OWNER/ADMIN has no path to this UI at all
 * (`/platform` is gated by `requirePlatformAdmin` at the layout level).
 * A downgrade is previewed (docs/adr/0035 "Plan change safety") but never
 * blocked — existing users/warehouses are never deleted; only future
 * creation past the new limit is refused afterward. CUSTOM ("Illimité")
 * is selectable here like BUSINESS/PRO — it is hand-assigned only, never
 * self-serve or advertised (see `listOfferedPlans` vs `listAllPlans`).
 */
export function TenantPlanDialog({
  tenantId,
  currentPlanCode,
  currentStatus,
}: {
  tenantId: string;
  currentPlanCode: PlanCode;
  currentStatus: SubscriptionStatus;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [planCode, setPlanCode] = useState<PlanCode>(currentPlanCode);
  const [status, setStatus] = useState<SubscriptionStatus>(currentStatus);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewTenantPlanChange>> | null>(null);
  const [isPending, startTransition] = useTransition();

  function selectPlan(next: PlanCode) {
    setPlanCode(next);
    startTransition(async () => {
      const p = await previewTenantPlanChange(tenantId, next);
      setPreview(p);
    });
  }

  function save() {
    startTransition(async () => {
      if (planCode !== currentPlanCode) {
        const formData = new FormData();
        formData.set("tenantId", tenantId);
        formData.set("planCode", planCode);
        const result = await changeTenantPlanAction(formData);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
      }
      if (status !== currentStatus) {
        const formData = new FormData();
        formData.set("tenantId", tenantId);
        formData.set("status", status);
        const result = await updateSubscriptionStatusAction(formData);
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
      }
      toast.success("Forfait mis à jour.");
      setOpen(false);
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPlanCode(currentPlanCode);
          setStatus(currentStatus);
          setPreview(null);
        }
      }}
    >
      <DialogTrigger render={<Button type="button" size="xs" variant="outline" />}>
        <Settings2 className="size-3.5" />
        Gérer le forfait
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Gérer le forfait</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Forfait</Label>
            <Select value={planCode} onValueChange={(v) => v && selectPlan(v as PlanCode)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(value: string) => PLAN_CODE_LABELS[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BUSINESS">Business</SelectItem>
                <SelectItem value="PRO">Pro</SelectItem>
                <SelectItem value="CUSTOM">Illimité (sur mesure)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {preview && preview.overLimits && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              Ce tenant dépasse actuellement les limites du forfait {PLAN_CODE_LABELS[planCode]}
              {preview.overUsers && ` (${formatNumber(preview.usage.users.used)} utilisateurs actifs pour une limite de ${formatNumber(preview.plan.maxUsers ?? 0)})`}
              {preview.overUsers && preview.overWarehouses && " et"}
              {preview.overWarehouses && ` (${formatNumber(preview.usage.warehouses.used)} entrepôts actifs pour une limite de ${formatNumber(preview.plan.maxWarehouses ?? 0)})`}
              . Aucune donnée ne sera supprimée — la création de nouvelles ressources sera simplement bloquée tant que
              l&apos;utilisation dépasse la limite.
            </p>
          )}

          <div className="space-y-1.5">
            <Label>Statut de l&apos;abonnement</Label>
            <Select value={status} onValueChange={(v) => v && setStatus(v as SubscriptionStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue>{(value: string) => SUBSCRIPTION_STATUS_LABELS[value]?.label ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Actif</SelectItem>
                <SelectItem value="TRIALING">Essai</SelectItem>
                <SelectItem value="PAST_DUE">Paiement en retard</SelectItem>
                <SelectItem value="CANCELED">Résilié</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Indépendant du statut du tenant (actif/suspendu) — un tenant en retard de paiement peut rester
              accessible tant qu&apos;il n&apos;est pas explicitement suspendu.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Annuler
          </Button>
          <Button type="button" onClick={save} disabled={isPending}>
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
