"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { KeyRound, Copy, Trash2 } from "lucide-react";
import { deleteUserAction, updateUserRoleAction, updateUserStatusAction } from "@/actions/users";
import { adminResetPasswordAction } from "@/actions/password-reset";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { UserRole, UserStatus } from "@prisma/client";

const ASSIGNABLE_ROLES = Object.entries(USER_ROLE_LABELS).filter(([value]) => value !== "OWNER");

export function UserRowControls({
  userId,
  name,
  email,
  role,
  status,
}: {
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");

  function deleteUser() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", userId);
      formData.set("confirmEmail", confirmEmail);
      const result = await deleteUserAction(formData);
      if (result.ok) {
        toast.success("Utilisateur supprimé.");
        setDeleteOpen(false);
        setConfirmEmail("");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function resetPassword() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("userId", userId);
      const result = await adminResetPasswordAction(formData);
      if (result.ok) {
        setResetLink(new URL(result.data.resetUrl, window.location.origin).toString());
      } else {
        toast.error(result.error);
      }
    });
  }

  if (role === "OWNER") {
    return <span className="text-sm text-muted-foreground">Propriétaire</span>;
  }

  return (
    <div className="flex items-center gap-3">
      <Select
        value={role}
        disabled={isPending}
        onValueChange={(value) => {
          if (!value) return;
          startTransition(async () => {
            const formData = new FormData();
            formData.set("id", userId);
            formData.set("role", value);
            const result = await updateUserRoleAction(formData);
            if (result.ok) {
              toast.success("Rôle mis à jour.");
              router.refresh();
            } else {
              toast.error(result.error);
            }
          });
        }}
      >
        <SelectTrigger className="w-40">
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
      <div className="flex items-center gap-1.5">
        <Switch
          checked={status === "ACTIVE"}
          disabled={isPending}
          onCheckedChange={(checked) => {
            startTransition(async () => {
              const formData = new FormData();
              formData.set("id", userId);
              formData.set("status", checked ? "ACTIVE" : "DISABLED");
              const result = await updateUserStatusAction(formData);
              if (result.ok) {
                toast.success("Statut mis à jour.");
                router.refresh();
              } else {
                toast.error(result.error);
              }
            });
          }}
        />
        <span className="text-xs text-muted-foreground">{status === "ACTIVE" ? "Actif" : "Désactivé"}</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={isPending}
        onClick={resetPassword}
        title="Réinitialiser le mot de passe"
      >
        <KeyRound className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={isPending}
        onClick={() => {
          setConfirmEmail("");
          setDeleteOpen(true);
        }}
        title="Supprimer l'utilisateur"
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </Button>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setConfirmEmail("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer l&apos;utilisateur</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>
              Le compte de <span className="font-medium text-foreground">{name}</span> ({email}) sera{" "}
              <span className="font-medium text-foreground">définitivement supprimé</span>, ainsi que ses sessions, ses
              notifications et son profil d&apos;agent de commission s&apos;il n&apos;a aucun historique.
            </p>
            <p>
              Les commandes, produits, clients et écritures créés par cet utilisateur sont{" "}
              <span className="font-medium text-foreground">conservés</span> — seule leur attribution à cet utilisateur
              est effacée.
            </p>
            <p>
              Pour confirmer, saisissez son e-mail&nbsp;: <span className="font-mono text-foreground">{email}</span>
            </p>
            <Input
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder={email}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)} disabled={isPending}>
              Annuler
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isPending || confirmEmail.trim().toLowerCase() !== email.toLowerCase()}
              onClick={deleteUser}
            >
              {isPending ? "Suppression..." : "Supprimer définitivement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetLink !== null} onOpenChange={(open) => !open && setResetLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lien de réinitialisation</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Transmettez ce lien à l&apos;utilisateur — il expire dans 1 heure et ne peut être utilisé qu&apos;une
            seule fois.
          </p>
          {resetLink && (
            <div className="flex items-center gap-2">
              <Input readOnly value={resetLink} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  navigator.clipboard.writeText(resetLink);
                  toast.success("Lien copié.");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setResetLink(null)}>
              Fermer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
