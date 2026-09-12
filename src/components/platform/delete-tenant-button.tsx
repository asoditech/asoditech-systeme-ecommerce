"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { deleteTenantAction } from "@/actions/tenants";
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
 * Platform-only, irreversible tenant deletion (docs/adr/0027 area). Gated
 * server-side by `requirePlatformAdminForAction` in `deleteTenantAction` —
 * this button is just the confirmation UX. Requires typing the tenant's own
 * slug rather than a checkbox: there is no undo (no soft-delete, no trash,
 * every row is gone).
 */
export function DeleteTenantButton({ tenantId, tenantSlug, tenantName }: { tenantId: string; tenantSlug: string; tenantName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [isPending, startTransition] = useTransition();

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
        if (!next) setConfirmation("");
      }}
    >
      <DialogTrigger render={<Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" />}>
        <Trash2 className="size-3.5" />
        Supprimer
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Supprimer « {tenantName} » ?</DialogTitle>
          <DialogDescription>
            Cette action est définitive et irréversible : toutes les données du tenant (commandes, produits, stock,
            clients, livraison, finance, comptes utilisateurs, sauvegardes, connecteurs…) seront supprimées
            immédiatement. Il n&apos;y a pas de corbeille ni de restauration possible.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
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
          <Button type="button" variant="destructive" onClick={run} disabled={isPending || confirmation !== tenantSlug}>
            {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Supprimer définitivement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
