"use client";

import { useActionState } from "react";
import { acceptInvitationAction } from "@/actions/invitations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field";

export function AcceptInvitationForm({ token, email }: { token: string; email: string }) {
  const [state, formAction, isPending] = useActionState(acceptInvitationAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-2">
        <Label>E-mail</Label>
        <Input value={email} disabled readOnly className="rounded-xl border-black/10 bg-white/40" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password" required>
          Choisissez un mot de passe
        </Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
          aria-invalid={state && !state.ok ? true : undefined}
          className="rounded-xl border-black/10 bg-white/70"
        />
      </div>
      <FieldError>{state && !state.ok ? state.error : null}</FieldError>
      <Button type="submit" size="lg" loading={isPending} className="w-full rounded-xl">
        {isPending ? "Création du compte…" : "Créer mon compte"}
      </Button>
    </form>
  );
}
