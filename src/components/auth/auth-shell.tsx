import { BrandMark } from "@/components/brand-mark";

/** The decorative glass-card shell every public auth-adjacent page uses —
 * login, and (Phase 5 — docs/adr/0027-tenant-provisioning.md) invitation
 * acceptance and password reset. Extracted from the original
 * src/app/connexion/page.tsx markup so these pages stay visually
 * consistent without duplicating it four times. */
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
    <div className="force-light relative flex min-h-screen items-center justify-center overflow-hidden bg-white p-4 text-foreground">
      <div
        aria-hidden
        className="animate-blob-breathe-a pointer-events-none absolute left-[28%] top-[22%] h-[420px] w-[420px] rounded-full opacity-60 blur-[90px]"
        style={{ backgroundImage: "radial-gradient(circle, #2563eb 0%, transparent 70%)" }}
      />
      <div
        aria-hidden
        className="animate-blob-breathe-b pointer-events-none absolute left-[74%] top-[28%] h-[360px] w-[360px] rounded-full opacity-50 blur-[90px]"
        style={{
          backgroundImage:
            "radial-gradient(ellipse at top, #ffd93d 0%, #ff8a3d 40%, #ff3d3d 70%, transparent 80%)",
        }}
      />
      <div
        aria-hidden
        className="animate-blob-breathe-c pointer-events-none absolute left-[50%] top-[80%] h-[380px] w-[460px] rounded-full opacity-40 blur-[100px]"
        style={{ backgroundImage: "radial-gradient(circle, #7c3aed 0%, transparent 70%)" }}
      />

      <div className="relative w-full max-w-sm rounded-3xl border border-white/60 bg-white/55 p-8 shadow-[0_20px_60px_-15px_rgba(30,41,59,0.25)] backdrop-blur-2xl">
        <div className="mb-8 flex flex-col items-center gap-6">
          <BrandMark variant="wordmark" />
          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
