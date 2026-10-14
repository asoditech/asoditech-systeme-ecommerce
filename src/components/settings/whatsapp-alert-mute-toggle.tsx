"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Minus } from "lucide-react";
import { setMyWhatsAppAlertMutedAction } from "@/actions/whatsapp";
import type { WhatsAppAlertType } from "@/lib/whatsapp/alert-types";
import { cn } from "@/lib/utils";

/**
 * The « WhatsApp » chip of one alert, as a real switch: pressed = this alert
 * reaches the user on WhatsApp; unpressed = muted for WhatsApp only (the
 * in-app / email channels of the same alert are unchanged). Own account only.
 */
export function WhatsAppAlertMuteToggle({ type, muted, label }: { type: WhatsAppAlertType; muted: boolean; label: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const on = !muted;

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${on ? "Couper" : "Réactiver"} WhatsApp pour « ${label} »`}
      title={on ? "Envoyé sur WhatsApp — cliquer pour couper" : "Coupé sur WhatsApp — cliquer pour réactiver"}
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await setMyWhatsAppAlertMutedAction(type, on);
          if (result.ok) {
            toast.success(on ? `WhatsApp coupé pour « ${label} ».` : `WhatsApp réactivé pour « ${label} ».`);
            router.refresh();
          } else {
            toast.error(result.error);
          }
        })
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none disabled:opacity-60",
        on
          ? "border-transparent bg-pill-green text-pill-green-fg hover:brightness-95"
          : "border-hairline text-ink-muted line-through hover:bg-row-hover"
      )}
    >
      {on ? <Check className="size-3" /> : <Minus className="size-3" />}
      WhatsApp
    </button>
  );
}
