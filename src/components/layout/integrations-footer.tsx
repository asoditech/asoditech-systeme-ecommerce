import { BrandLogo } from "@/components/brand-logo";

/**
 * A quiet credibility strip at the bottom of every page: the delivery
 * carriers and e-commerce platforms ASODITECH integrates with. Purely
 * informational / professional — no links, no interaction.
 */
export function IntegrationsFooter() {
  return (
    <footer className="mt-10 border-t pt-5 pb-2 text-xs text-muted-foreground print:hidden">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2.5">
          <span className="font-medium">Livraison</span>
          <span className="flex items-center gap-3">
            <BrandLogo brand="ozonexpress" label="OzonExpress" className="h-4 w-16" />
            <BrandLogo brand="aramex" label="Aramex" className="h-4 w-14" />
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="font-medium">E-commerce</span>
          <span className="flex items-center gap-3">
            <BrandLogo brand="woocommerce" label="WooCommerce" className="h-4 w-16" />
            <BrandLogo brand="shopify" label="Shopify" className="h-4 w-16" />
          </span>
        </div>
        <span className="text-muted-foreground/70">
          Intégrations disponibles — OzonExpress · Aramex pour la livraison, WooCommerce · Shopify pour le e-commerce.
        </span>
      </div>
    </footer>
  );
}
