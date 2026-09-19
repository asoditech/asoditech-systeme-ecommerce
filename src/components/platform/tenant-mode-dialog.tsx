"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Store } from "lucide-react";
import { setTenantBusinessModeAction, previewTenantBusinessModeChange } from "@/actions/tenants";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BUSINESS_MODES, BUSINESS_MODE_DESCRIPTIONS, BUSINESS_MODE_LABELS, type BusinessMode } from "@/lib/tenant/business-mode";

/**
 * Platform-only business-mode control (docs/adr/0041). Every mutation goes
 * through `requirePlatformAdminForAction` server-side; a tenant's own OWNER/ADMIN
 * has no path to this UI (`/platform` is gated at the layout) and the action
 * refuses any other caller. A downgrade is PREVIEWED and refused while the tenant
 * owns Offline documents — the reason is shown here, and enforced again on save.
 */
export function TenantModeDialog({ tenantId, currentMode }: { tenantId: string; currentMode: BusinessMode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<BusinessMode>(currentMode);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function choose(next: BusinessMode) {
    setMode(next);
    setRefusal(null);
    if (next === currentMode) return;
    startTransition(async () => {
      const plan = await previewTenantBusinessModeChange(tenantId, next);
      setRefusal(plan && !plan.allowed ? plan.reason : null);
    });
  }

  function save() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("tenantId", tenantId);
      fd.set("businessMode", mode);
      const r = await setTenantBusinessModeAction(fd);
      if (r.ok) {
        toast.success("Mode d'activité mis à jour.");
        setOpen(false);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setMode(currentMode);
          setRefusal(null);
        }
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <Store className="size-3.5" />
        Mode
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mode d&apos;activité</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {BUSINESS_MODES.map((m) => (
            <label
              key={m}
              className={"flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm " + (mode === m ? "border-primary bg-primary/5" : "")}
            >
              <input type="radio" name="businessMode" className="mt-1" checked={mode === m} onChange={() => choose(m)} />
              <span>
                <span className="font-medium">{BUSINESS_MODE_LABELS[m]}</span>
                {m === currentMode && <span className="ml-2 text-xs text-muted-foreground">(actuel)</span>}
                <span className="block text-xs text-muted-foreground">{BUSINESS_MODE_DESCRIPTIONS[m]}</span>
              </span>
            </label>
          ))}
        </div>
        {refusal && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{refusal}</p>}
        {!refusal && mode === "ONLINE_AND_OFFLINE" && mode !== currentMode && (
          <p className="text-xs text-muted-foreground">
            Débloque : ventes magasin, achats et fournisseurs, canaux de vente, codes-barres, traçabilité. Rien n&apos;est créé ni modifié dans les données existantes.
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
            Annuler
          </Button>
          <Button type="button" onClick={save} disabled={isPending || mode === currentMode || Boolean(refusal)}>
            {isPending ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
