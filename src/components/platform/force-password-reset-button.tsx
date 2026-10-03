"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { forcePasswordResetAction } from "@/actions/password-reset";
import { Button } from "@/components/ui/button";

/** Platform owner: force a new password — the user gets a reset link by e-mail; no password is ever shown. */
export function ForcePasswordResetButton({ userId, email }: { userId: string; email: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      loading={isPending}
      onClick={() => {
        if (!window.confirm(`Forcer ${email} à choisir un nouveau mot de passe ? Ses sessions seront fermées et un lien de réinitialisation lui sera envoyé.`)) return;
        startTransition(async () => {
          const fd = new FormData();
          fd.set("userId", userId);
          const r = await forcePasswordResetAction(fd);
          if (r.ok) toast.success("Réinitialisation imposée — lien envoyé à l'utilisateur.");
          else toast.error(r.error);
        });
      }}
    >
      <KeyRound className="size-3.5" />
      Forcer la réinitialisation
    </Button>
  );
}
