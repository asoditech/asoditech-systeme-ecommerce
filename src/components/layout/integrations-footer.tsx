import { BrandLogo } from "@/components/brand-logo";

/**
 * A quiet credibility strip fixed to the bottom of the content area: the
 * carriers and e-commerce platform ASODITECH integrates with, plus the
 * ownership line. Purely informational — no links, no interaction.
 * Deliberately thin (h-9) with a solid background so it reads as chrome,
 * not content; `<main>` carries matching bottom padding so nothing hides
 * behind it.
 */
export function IntegrationsFooter() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 h-9 border-t bg-background text-[11px] text-muted-foreground/80 md:left-64 print:hidden">
      <div className="mx-auto flex h-full w-full max-w-[1600px] items-center justify-between gap-3 px-4 md:px-6">
        <span className="hidden items-center gap-2 sm:flex">
          <span className="hidden md:inline">Intégrations</span>
          <BrandLogo brand="ozonexpress" label="OzonExpress" className="h-3.5 w-14" />
          <BrandLogo brand="aramex" label="Aramex" className="h-3.5 w-12" />
          <span className="mx-0.5 h-3 w-px bg-border" aria-hidden="true" />
          <BrandLogo brand="woocommerce" label="WooCommerce" className="h-3.5 w-14" />
        </span>
        <span className="truncate text-muted-foreground/70">
          <span className="sm:hidden">© 2026 ASODITECH — YounessWeb</span>
          <span className="hidden sm:inline">
            © 2026 ASODITECH — Tous droits réservés. Système protégé et développé par YounessWeb.
          </span>
        </span>
      </div>
    </footer>
  );
}
