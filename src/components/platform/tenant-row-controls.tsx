"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { activateTenantAction, suspendTenantAction } from "@/actions/tenants";
import { Switch } from "@/components/ui/switch";
import type { TenantStatus } from "@prisma/client";

export function TenantRowControls({ tenantId, status }: { tenantId: string; status: TenantStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (tenantId === "default") {
    return <span className="text-sm text-muted-foreground">Tenant d&apos;amorçage</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <Switch
        checked={status === "ACTIVE"}
        disabled={isPending}
        onCheckedChange={(checked) => {
          startTransition(async () => {
            const formData = new FormData();
            formData.set("id", tenantId);
            const result = await (checked ? activateTenantAction(formData) : suspendTenantAction(formData));
            if (result.ok) {
              toast.success(checked ? "Tenant activé." : "Tenant suspendu.");
              router.refresh();
            } else {
              toast.error(result.error);
            }
          });
        }}
      />
      <span className="text-xs text-muted-foreground">{status === "ACTIVE" ? "Actif" : "Suspendu"}</span>
    </div>
  );
}
