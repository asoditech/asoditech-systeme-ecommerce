"use client";

import { useActionState } from "react";
import { requestPasswordResetAction } from "@/actions/password-reset";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field";

export function ForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(requestPasswordResetAction, undefined);

  if (state && state.ok) {
    return (
      <p className="text-sm text-muted-foreground">
        Si un compte existe pour cette adresse, un lien de réinitialisation a été généré. Contactez votre
        administrateur si vous ne le recevez pas.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email" required>
          E-mail
        </Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={state && !state.ok ? true : undefined}
          className="rounded-xl border-black/10 bg-white/70"
        />
      </div>
      <FieldError>{state && !state.ok ? state.error : null}</FieldError>
      <Button type="submit" size="lg" loading={isPending} className="w-full rounded-xl">
        {isPending ? "Envoi…" : "Envoyer le lien de réinitialisation"}
      </Button>
    </form>
  );
}
