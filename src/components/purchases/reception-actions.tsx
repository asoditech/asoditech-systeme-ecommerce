"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, XCircle } from "lucide-react";
import { validateReceptionAction, cancelReceptionAction } from "@/actions/purchases";
import { Button } from "@/components/ui/button";

/** Validate (adds stock through the canonical movement, once) or cancel a DRAFT reception. */
export function ReceptionActions({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(ok);
        router.refresh();
      } else toast.error(r.error ?? "Action impossible.");
    });
  return (
    <div className="flex gap-2">
      <Button type="button" disabled={isPending} onClick={() => run(() => validateReceptionAction({ id }), "Réception validée — stock ajouté.")}>
        <CheckCircle2 className="size-4" />
        Valider et ajouter au stock
      </Button>
      <Button type="button" variant="outline" disabled={isPending} onClick={() => run(() => cancelReceptionAction({ id }), "Brouillon annulé.")}>
        <XCircle className="size-4" />
        Annuler
      </Button>
    </div>
  );
}
