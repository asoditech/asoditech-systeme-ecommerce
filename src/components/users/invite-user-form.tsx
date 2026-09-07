"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Copy } from "lucide-react";
import { inviteUserAction } from "@/actions/invitations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { ActionResult, IdResult } from "@/actions/types";

const ASSIGNABLE_ROLES = Object.entries(USER_ROLE_LABELS).filter(([value]) => value !== "OWNER");

type InviteResult = ActionResult<IdResult & { inviteUrl: string }>;

export function InviteUserForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [state, formAction, isPending] = useActionState<InviteResult | undefined, FormData>(
    async (_prevState, formData) => {
      const result = await inviteUserAction(formData);
      if (result.ok) {
        toast.success("Invitation créée.");
        setInviteLink(new URL(result.data.inviteUrl, window.location.origin).toString());
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  function close() {
    setOpen(false);
    setInviteLink(null);
  }

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
        Inviter un utilisateur
      </DialogTrigger>
      <DialogContent>
        {inviteLink ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation créée</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Transmettez ce lien à la personne invitée — il n&apos;expire pas avant 7 jours et ne peut être utilisé
              qu&apos;une seule fois.
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
              <Button type="button" onClick={close}>
                Fermer
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Inviter un utilisateur</DialogTitle>
            </DialogHeader>
            <form action={formAction} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Nom complet</Label>
                <Input id="name" name="name" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">E-mail</Label>
                <Input id="email" name="email" type="email" required />
                {state && !state.ok && state.fieldErrors?.email && (
                  <p className="text-xs text-destructive">{state.fieldErrors.email[0]}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">Rôle</Label>
                <Select name="role" defaultValue="CONFIRMATION">
                  <SelectTrigger id="role" className="w-full">
                    <SelectValue>{(value: string) => USER_ROLE_LABELS[value] ?? value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Envoi..." : "Envoyer l'invitation"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
