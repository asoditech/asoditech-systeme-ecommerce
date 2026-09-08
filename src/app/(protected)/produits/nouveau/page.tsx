import { ExternalLink, Store, ShoppingBag, LogIn } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProductForm } from "@/components/products/product-form";
import { requirePermission } from "@/lib/auth/guards";
import { getConnectedCommercePlatforms } from "@/lib/integrations/shared";
import { listCategories } from "@/lib/queries/products";

export const metadata = { title: "Ajouter un produit — ASODITECH Gestion E-commerce" };

const PLATFORM_ICON = { WOOCOMMERCE: Store, SHOPIFY: ShoppingBag } as const;

/**
 * Two modes (docs/adr/0017-product-management-boundary.md):
 *
 *  - A store IS connected → product *definition* is owned by that
 *    platform; this page only points the operator at the real creation
 *    UI (a native form here would just be overwritten by the next sync).
 *  - NO store connected → ASODITECH is the only catalogue the tenant has,
 *    so it renders its own creation form. This is the standalone-tenant
 *    case (a client running the app without WooCommerce/Shopify).
 */
export default async function NouveauProduitPage() {
  await requirePermission("products.create");
  const platforms = await getConnectedCommercePlatforms();

  if (platforms.length === 0) {
    const categories = await listCategories();
    return (
      <div>
        <PageHeader
          title="Ajouter un produit"
          breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: "Ajouter" }]}
          description="Aucune plateforme e-commerce connectée — créez le produit directement dans ASODITECH."
        />
        <div className="max-w-3xl">
          <ProductForm categories={categories} />
          <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
            <LogIn className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Si vous connectez plus tard WooCommerce ou Shopify, la fiche produit (nom, prix, description) sera gérée
              depuis cette plateforme et synchronisée ici.
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Ajouter un produit"
        breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: "Ajouter" }]}
        description="Une plateforme e-commerce est connectée — la création de produit se fait sur cette plateforme, puis se synchronise ici."
      />

      <div className={platforms.length === 1 ? "max-w-sm" : "grid max-w-xl gap-4 sm:grid-cols-2"}>
        {platforms.map((platform) => {
          const Icon = PLATFORM_ICON[platform.provider];
          return (
            <Card key={platform.provider}>
              <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Icon className="size-6" />
                </div>
                <div>
                  <p className="font-medium">{platform.label}</p>
                  <p className="text-xs text-muted-foreground">Créer le produit sur {platform.label}</p>
                </div>
                <Button
                  render={
                    <a
                      href={platform.createUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Ouvre l'administration ${platform.label} — connectez-vous d'abord si nécessaire.`}
                    />
                  }
                >
                  Ajouter sur {platform.label}
                  <ExternalLink className="size-4" />
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="mt-4 flex max-w-xl items-start gap-1.5 text-xs text-muted-foreground">
        <LogIn className="mt-0.5 size-3.5 shrink-0" />
        <span>Ces boutons ouvrent l&apos;administration réelle de la plateforme — connectez-vous d&apos;abord si nécessaire.</span>
      </p>
    </div>
  );
}
