"use client";

import { useActionState } from "react";
import { unlockPlatformAction } from "@/actions/platform-access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldError } from "@/components/ui/field";

export function PlatformUnlockForm() {
  const [state, formAction, isPending] = useActionState(unlockPlatformAction, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="platform-key" required>
          Clé d&apos;accès plateforme
        </Label>
        <Input
          id="platform-key"
          name="key"
          type="password"
          autoComplete="off"
          required
          aria-invalid={state && !state.ok ? true : undefined}
          className="rounded-xl border-black/10 bg-white/70"
        />
      </div>
      <FieldError>{state && !state.ok ? state.error : null}</FieldError>
      <Button type="submit" size="lg" loading={isPending} className="w-full rounded-xl">
        {isPending ? "Vérification…" : "Déverrouiller"}
      </Button>
    </form>
  );
}
