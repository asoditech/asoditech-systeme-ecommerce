"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTenantCustomerBarcodeGrantAction } from "@/actions/tenants";
import { Switch } from "@/components/ui/switch";

/**
 * Platform grant of automatic customer codes « CL-000001 » for one tenant
 * (docs/adr/0060). Granting only lets the tenant turn the feature on in its
 * own settings; revoking stops new codes and switches that setting off —
 * existing customer codes are kept.
 */
export function TenantCustomerBarcodeSwitch({ tenantId, tenantName, granted }: { tenantId: string; tenantName: string; granted: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1.5">
      <Switch
        checked={granted}
        disabled={isPending}
        aria-label={`Codes clients automatiques pour ${tenantName}`}
        onCheckedChange={(checked) => {
          startTransition(async () => {
            const formData = new FormData();
            formData.set("tenantId", tenantId);
            formData.set("granted", checked ? "true" : "false");
            const result = await setTenantCustomerBarcodeGrantAction(formData);
            if (result.ok) {
              toast.success(checked ? "Codes clients autorisés pour ce tenant." : "Codes clients retirés : plus aucun nouveau code ne sera attribué.");
              router.refresh();
            } else {
              toast.error(result.error);
            }
          });
        }}
      />
      <span className="text-xs text-muted-foreground">{granted ? "Autorisés" : "Non autorisés"}</span>
    </div>
  );
}
