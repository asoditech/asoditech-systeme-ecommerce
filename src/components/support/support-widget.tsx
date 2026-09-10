"use client";

import { useEffect, useId, useState } from "react";
import { usePathname } from "next/navigation";
import { LifeBuoy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveSupportContext } from "@/lib/support/context";
import { SupportQuickActions } from "@/components/support/support-quick-actions";
import { SupportContactSection } from "@/components/support/support-contact-section";

export interface SupportWidgetConfig {
  name: string | null;
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  hours: string | null;
  companyName: string;
}

/**
 * Floating "Centre d'aide" widget, mounted once in the protected app shell
 * (src/components/layout/app-shell.tsx). Compact button when closed; opens
 * a modern support panel — a bottom-right card on desktop, a bottom sheet
 * on mobile.
 *
 * It is a thin entry point, not a second system: the quick actions call
 * the existing controlled AI tools (already filtered to this user's role
 * server-side), and the human-contact actions use the tenant's configured
 * support numbers. Nothing here re-implements business logic.
 */
export function SupportWidget({
  canUseAi,
  questions,
  config,
}: {
  canUseAi: boolean;
  questions: { id: string; label: string }[];
  config: SupportWidgetConfig;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const context = resolveSupportContext(pathname ?? "/");
  const titleId = useId();

  // Close when the user navigates — the context has moved on. Adjusting
  // state during render (React's sanctioned pattern) rather than in an
  // effect, so there's no extra paint.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const hasContact = Boolean(config.whatsapp || config.phone || config.email);

  return (
    <>
      {/* Trigger */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ouvrir le centre d'aide"
          className={cn(
            "fixed right-4 bottom-4 z-40 flex items-center gap-2 rounded-full border border-border bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none sm:right-6 sm:bottom-6 print:hidden",
          )}
        >
          <LifeBuoy className="size-5" />
          <span className="hidden sm:inline">Centre d&apos;aide</span>
        </button>
      )}

      {open && (
        <>
          {/* Mobile backdrop */}
          <div
            className="fixed inset-0 z-40 bg-black/40 sm:hidden print:hidden"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <div
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            className={cn(
              "fixed z-50 flex flex-col overflow-hidden border border-border bg-popover text-popover-foreground shadow-2xl print:hidden",
              // Mobile: bottom sheet
              "inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl",
              // Desktop: compact bottom-right card
              "sm:inset-x-auto sm:right-6 sm:bottom-6 sm:max-h-[min(620px,calc(100vh-6rem))] sm:w-[380px] sm:rounded-2xl",
            )}
          >
            <header className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <LifeBuoy className="size-4 text-primary" />
                <div>
                  <p id={titleId} className="text-sm font-semibold">
                    Centre d&apos;aide
                  </p>
                  <p className="text-[11px] text-muted-foreground">{config.companyName}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
              {canUseAi && questions.length > 0 ? (
                <SupportQuickActions questions={questions} context={context} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Besoin d&apos;aide&nbsp;? Contactez notre équipe ci-dessous.
                </p>
              )}

              <SupportContactSection
                config={config}
                context={context}
                pageUrl={pathname ?? undefined}
                hasContact={hasContact}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
