import { BrandLogo } from "@/components/brand-logo";

/**
 * A quiet credibility strip at the bottom of every page: the carriers and
 * e-commerce platform ASODITECH integrates with, plus the ownership line.
 * Purely informational — no links, no interaction. Deliberately compact:
 * one row on desktop, a short stack on mobile, minimal vertical footprint
 * (client feedback #1).
 */
export function IntegrationsFooter() {
  return (
    <footer className="mt-6 border-t pt-3 pb-3 text-[11px] text-muted-foreground/80 print:hidden">
      <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center gap-1.5 sm:flex-row sm:justify-between">
        <span className="flex items-center gap-2">
          <span className="hidden sm:inline">Intégrations</span>
          <BrandLogo brand="ozonexpress" label="OzonExpress" className="h-3.5 w-14" />
          <BrandLogo brand="aramex" label="Aramex" className="h-3.5 w-12" />
          <span className="mx-0.5 h-3 w-px bg-border" aria-hidden="true" />
          <BrandLogo brand="woocommerce" label="WooCommerce" className="h-3.5 w-14" />
        </span>
        <span className="text-center text-muted-foreground/70 sm:text-right">
          © 2026 ASODITECH — Tous droits réservés. Système protégé et développé par YounessWeb.
        </span>
      </div>
    </footer>
  );
}
