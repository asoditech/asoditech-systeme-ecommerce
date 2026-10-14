import { cookies } from "next/headers";
import { Lock } from "lucide-react";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { LogoutButton } from "@/components/layout/logout-button";
import { PlatformShell } from "@/components/platform/platform-shell";
import { Button } from "@/components/ui/button";
import { lockPlatformAction } from "@/actions/platform-access";

/**
 * The `/platform` area (Phase 5 — docs/adr/0027-tenant-provisioning.md) is
 * deliberately NOT nested under `(protected)` — that layout's sidebar is
 * full of tenant-scoped nav (orders, products, …) which makes no sense
 * here, and `requirePlatformAdmin` is a stricter, separate gate from the
 * regular per-tenant RBAC every other protected page uses.
 *
 * Soft UI: same shell as the merchant app (PlatformShell), told apart by the
 * purple « Plateforme » badge and active pill. The sidebar collapse cookie is
 * the same per-browser UI preference as in the merchant app.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  const sidebarCollapsed = (await cookies()).get("sidebar-collapsed")?.value === "1";

  return (
    <PlatformShell
      defaultCollapsed={sidebarCollapsed}
      actions={
        <>
          <form action={lockPlatformAction}>
            <Button type="submit" variant="outline" className="rounded-full px-3 sm:px-4" aria-label="Verrouiller">
              <Lock className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Verrouiller</span>
            </Button>
          </form>
          <LogoutButton />
        </>
      }
    >
      {children}
    </PlatformShell>
  );
}
