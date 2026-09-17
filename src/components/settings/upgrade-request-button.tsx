"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { requestPlanUpgradeAction } from "@/actions/plans";
import { Button } from "@/components/ui/button";

export function UpgradeRequestButton({ requestedPlanCode, label }: { requestedPlanCode: "PRO"; label: string }) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          try {
            const formData = new FormData();
            formData.set("requestedPlanCode", requestedPlanCode);
            const result = await requestPlanUpgradeAction(formData);
            if (result.ok) {
              toast.success("Votre demande a été envoyée. Notre équipe vous contactera rapidement.");
            } else {
              toast.error(result.error);
            }
          } catch {
            // An unexpected server-side failure must degrade to a toast,
            // never a hard crash for someone just requesting an upgrade.
            toast.error("Une erreur est survenue. Merci de réessayer, ou de nous contacter via le centre d'aide.");
          }
        });
      }}
    >
      {label}
    </Button>
  );
}
