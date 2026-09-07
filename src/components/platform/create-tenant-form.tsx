"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Copy } from "lucide-react";
import { createTenantAction } from "@/actions/tenants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionResult, IdResult } from "@/actions/types";

type CreateResult = ActionResult<IdResult & { inviteUrl: string }>;

export function CreateTenantForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [state, formAction, isPending] = useActionState<CreateResult | undefined, FormData>(
    async (_prevState, formData) => {
      const result = await createTenantAction(formData);
      if (result.ok) {
        toast.success("Tenant créé.");
        setInviteLink(new URL(result.data.inviteUrl, window.location.origin).toString());
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setInviteLink(null);
      }}
    >
      <DialogTrigger render={<Button type="button" />}>
        <Plus className="size-4" />
        Nouveau tenant
      </DialogTrigger>
      <DialogContent>
        {inviteLink ? (
          <>
            <DialogHeader>
              <DialogTitle>Tenant créé</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Transmettez ce lien au propriétaire du nouveau tenant pour qu&apos;il crée son compte.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteLink} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  navigator.clipboard.writeText(inviteLink);
                  toast.success("Lien copié.");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setInviteLink(null);
                }}
              >
                Fermer
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Nouveau tenant</DialogTitle>
            </DialogHeader>
            <form action={formAction} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Nom de l&apos;entreprise</Label>
                <Input id="name" name="name" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="slug">Identifiant</Label>
                <Input id="slug" name="slug" placeholder="mon-entreprise" required />
                {state && !state.ok && state.fieldErrors?.slug && (
                  <p className="text-xs text-destructive">{state.fieldErrors.slug[0]}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ownerName">Nom du propriétaire</Label>
                <Input id="ownerName" name="ownerName" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ownerEmail">E-mail du propriétaire</Label>
                <Input id="ownerEmail" name="ownerEmail" type="email" required />
                {state && !state.ok && state.fieldErrors?.ownerEmail && (
                  <p className="text-xs text-destructive">{state.fieldErrors.ownerEmail[0]}</p>
                )}
              </div>
              {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Création..." : "Créer le tenant"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
