"use client";

import { useState, useTransition } from "react";
import type { TenantPurgePreview } from "@/lib/tenant/delete";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { deleteTenantAction, previewTenantPurgeAction } from "@/actions/tenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Platform-only, irreversible TRIAL purge (docs/adr/0027, 0053). Gated
 * server-side (`requirePlatformAdminForAction`, trial-only rule, zero-row
 * proof in the transaction) — this is just the confirmation UX: opening it
 * runs the dry-run, which shows what would be removed or why it is refused;
 * confirming still requires typing the tenant's own slug.
 */
export function DeleteTenantButton({ tenantId, tenantSlug, tenantName }: { tenantId: string; tenantSlug: string; tenantName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [isPending, startTransition] = useTransition();
  const [preview, setPreview] = useState<TenantPurgePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function loadPreview() {
    setPreview(null);
    setPreviewError(null);
    startTransition(async () => {
      const result = await previewTenantPurgeAction(tenantId);
      if (result.ok) setPreview(result.data);
      else setPreviewError(result.error);
    });
  }

  if (tenantId === "default") return null;

  function run() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", tenantId);
      formData.set("slugConfirmation", confirmation);
      const result = await deleteTenantAction(formData);
      if (result.ok) {
        toast.success(`Tenant « ${tenantName} » supprimé.`);
        setOpen(false);
        setConfirmation("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) loadPreview();
        else setConfirmation("");
      }}
    >
      <DialogTrigger render={<Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" />}>
        <Trash2 className="size-3.5" />
        Purger l&apos;essai
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Purger l&apos;essai « {tenantName} » ?</DialogTitle>
          <DialogDescription>
            Cette action est définitive et irréversible : toutes les données du tenant (commandes, produits, stock,
            clients, livraison, finance, comptes utilisateurs, sauvegardes, connecteurs…) seront supprimées
            immédiatement. Il n&apos;y a pas de corbeille ni de restauration possible.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            {previewError ? (
              <p className="text-destructive">{previewError}</p>
            ) : !preview ? (
              <p className="text-muted-foreground">Calcul des données concernées…</p>
            ) : (
              <>
                <p className="font-medium">
                  Simulation : {preview.total} enregistrement(s) seraient supprimés.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {Object.entries(preview.counts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([table, n]) => `${table} ${n}`)
                    .join(" · ") || "Aucune donnée."}
                </p>
                {preview.refusal && <p className="mt-2 text-destructive">{preview.refusal}</p>}
              </>
            )}
          </div>
          <Label htmlFor="delete-tenant-confirmation">
            Tapez <span className="font-mono font-semibold">{tenantSlug}</span> pour confirmer
          </Label>
          <Input
            id="delete-tenant-confirmation"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
            Annuler
          </Button>
          <Button type="button" variant="destructive" onClick={run} disabled={isPending || confirmation !== tenantSlug || !preview || preview.refusal !== null}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Purger définitivement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
