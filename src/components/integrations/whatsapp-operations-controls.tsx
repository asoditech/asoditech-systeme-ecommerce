"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCw } from "lucide-react";
import { retryWhatsAppOutboxMessageAction, setCompanyWhatsAppAlertEnabledAction } from "@/actions/whatsapp";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { WhatsAppAlertType } from "@/lib/whatsapp/alert-types";

/** Company-level on/off of one WhatsApp alert category (server-enforced `integrations.manage`, audited). */
export function WhatsAppCategorySwitch({ type, label, enabled }: { type: WhatsAppAlertType; label: string; enabled: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Switch
      aria-label={`${enabled ? "Désactiver" : "Activer"} WhatsApp pour « ${label} » (toute l'entreprise)`}
      checked={enabled}
      disabled={isPending}
      onCheckedChange={(value) =>
        startTransition(async () => {
          const result = await setCompanyWhatsAppAlertEnabledAction(type, value === true);
          if (result.ok) toast.success(value ? `WhatsApp activé pour « ${label} ».` : `WhatsApp désactivé pour « ${label} ».`);
          else toast.error(result.error);
          router.refresh();
        })
      }
    />
  );
}

/** « Réessayer » one ECHEC alert of this company. */
export function WhatsAppRetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await retryWhatsAppOutboxMessageAction(id);
          if (!result.ok) toast.error(result.error);
          else if (result.data.status === "ENVOYE") toast.success("Alerte WhatsApp envoyée.");
          else if (result.data.status === "EN_ATTENTE") toast.info("Nouvel échec temporaire : un autre essai est programmé.");
          else toast.error("L'alerte n'a pas pu être envoyée — voir le détail de l'erreur.");
          router.refresh();
        })
      }
    >
      <RotateCw className="size-3.5" />
      Réessayer
    </Button>
  );
}
