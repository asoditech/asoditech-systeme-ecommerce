"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { testWhatsAppConnectionAction } from "@/actions/whatsapp";
import { disconnectIntegrationAction } from "@/actions/integrations";
import { Button } from "@/components/ui/button";

/** « Activer » / « Tester la connexion » (reads the sending number from Meta, sends nothing) and « Désactiver ». */
export function WhatsAppActions({ enabled, hasRow }: { enabled: boolean; hasRow: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function test() {
    startTransition(async () => {
      const result = await testWhatsAppConnectionAction();
      if (result.ok) toast.success(enabled ? "Connexion WhatsApp vérifiée." : "Notifications WhatsApp activées.");
      else toast.error(result.error);
      router.refresh();
    });
  }

  function disable() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("provider", "WHATSAPP");
      const result = await disconnectIntegrationAction(fd);
      if (result.ok) toast.success("Notifications WhatsApp désactivées.");
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <>
      <Button type="button" size="sm" variant={enabled ? "outline" : "default"} disabled={isPending} onClick={test}>
        {enabled ? "Tester la connexion" : "Activer"}
      </Button>
      {hasRow && (
        <Button type="button" size="sm" variant="ghost" disabled={isPending} onClick={disable}>
          Désactiver
        </Button>
      )}
    </>
  );
}
