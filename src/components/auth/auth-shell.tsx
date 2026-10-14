import { BrandMark } from "@/components/brand-mark";

/** The shell every public auth-adjacent page uses — login, and (Phase 5 —
 * docs/adr/0027-tenant-provisioning.md) invitation acceptance and password
 * reset, platform unlock. Soft UI: always-light grey page with one white
 * 32px card and the soft shell shadow (no decorative blobs). */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="force-light flex min-h-screen items-center justify-center bg-page p-4 text-ink">
      <div className="w-full max-w-sm rounded-shell bg-card p-8 shadow-shell">
        <div className="mb-8 flex flex-col items-center gap-6">
          <BrandMark variant="wordmark" />
          <div className="space-y-1.5 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
            <p className="text-sm text-ink-secondary">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
