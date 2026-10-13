import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ThemeSegmented } from "@/components/layout/theme-segmented";
import { Showcase } from "./showcase";

/**
 * Soft UI redesign — internal component gallery (REDESIGN_PROGRESS.md).
 * Not linked anywhere and never served by a production build: the route is
 * a 404 whenever NODE_ENV is "production". Every shared component is shown
 * twice, in a light and a dark panel; overlays (menus, dialogs, toasts)
 * render in a portal and follow the global theme switch at the top.
 */
export const metadata: Metadata = {
  title: "Composants (dev)",
  robots: { index: false, follow: false },
};

export default function DevComponentsPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="min-h-dvh bg-page p-4 md:p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-card bg-shell px-6 py-4 shadow-card">
        <div>
          <p className="text-lg font-semibold text-ink">Soft UI — composants partagés</p>
          <p className="text-sm text-ink-secondary">
            Page interne de développement (non liée, 404 en production). Les menus, dialogues et toasts suivent le thème global :
          </p>
        </div>
        <div className="w-56">
          <ThemeSegmented />
        </div>
      </div>
      <div className="grid gap-6 2xl:grid-cols-2">
        <section aria-label="Thème clair" className="force-light min-w-0 rounded-shell bg-content p-5 text-foreground md:p-8">
          <p className="mb-6 inline-flex rounded-full bg-shell px-3 py-1 text-xs font-medium text-ink-secondary shadow-soft">Clair</p>
          <Showcase id="light" />
        </section>
        <section aria-label="Thème sombre" className="dark min-w-0 rounded-shell bg-content p-5 text-foreground md:p-8 [color-scheme:dark]">
          <p className="mb-6 inline-flex rounded-full bg-shell px-3 py-1 text-xs font-medium text-ink-secondary shadow-soft">Sombre</p>
          <Showcase id="dark" />
        </section>
      </div>
    </div>
  );
}
