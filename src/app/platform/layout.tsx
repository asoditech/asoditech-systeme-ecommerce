import { requirePlatformAdmin } from "@/lib/auth/guards";
import { BrandMark } from "@/components/brand-mark";
import { LogoutButton } from "@/components/layout/logout-button";

/**
 * The `/platform` area (Phase 5 — docs/adr/0027-tenant-provisioning.md) is
 * deliberately NOT nested under `(protected)` — that layout's sidebar is
 * full of tenant-scoped nav (orders, products, …) which makes no sense
 * here, and `requirePlatformAdmin` is a stricter, separate gate from the
 * regular per-tenant RBAC every other protected page uses.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="flex items-center justify-between border-b bg-background px-6 py-4">
        <div className="flex items-center gap-3">
          <BrandMark variant="wordmark" />
          <span className="rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground">
            Plateforme
          </span>
        </div>
        <LogoutButton />
      </header>
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
