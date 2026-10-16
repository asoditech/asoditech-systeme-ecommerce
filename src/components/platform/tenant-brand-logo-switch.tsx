"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTenantBrandLogoGrantAction } from "@/actions/tenants";
import { Switch } from "@/components/ui/switch";

/**
 * Platform grant of the company's own logo in the app shell for one tenant.
 * Granting lets the shell show the logo the company set in Paramètres
 * (ASODITECH mark when none / invalid); revoking restores ASODITECH branding
 * at once — the company's logo itself is kept for its documents.
 */
export function TenantBrandLogoSwitch({ tenantId, tenantName, granted }: { tenantId: string; tenantName: string; granted: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1.5">
      <Switch
        checked={granted}
        disabled={isPending}
        aria-label={`Logo de l'entreprise dans le menu pour ${tenantName}`}
        onCheckedChange={(checked) => {
          startTransition(async () => {
            const formData = new FormData();
            formData.set("tenantId", tenantId);
            formData.set("granted", checked ? "true" : "false");
            const result = await setTenantBrandLogoGrantAction(formData);
            if (result.ok) {
              toast.success(checked ? "Logo de l'entreprise autorisé dans le menu." : "Logo retiré : le menu affiche de nouveau ASODITECH.");
              router.refresh();
            } else {
              toast.error(result.error);
            }
          });
        }}
      />
      <span className="text-xs text-muted-foreground">{granted ? "Autorisé" : "ASODITECH"}</span>
    </div>
  );
}
