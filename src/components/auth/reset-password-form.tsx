"use client";

import { useActionState } from "react";
import { resetPasswordAction } from "@/actions/password-reset";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction, isPending] = useActionState(resetPasswordAction, undefined);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-2">
        <Label htmlFor="password" required>
          Nouveau mot de passe
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
        {isPending ? "Mise à jour…" : "Réinitialiser le mot de passe"}
      </Button>
    </form>
  );
}
