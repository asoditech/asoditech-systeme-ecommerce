import Link from "next/link";
import { ExternalLink, Plug, Store, ShoppingBag, LogIn } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/guards";
import { getConnectedCommercePlatforms } from "@/lib/integrations/shared";

export const metadata = { title: "Ajouter un produit — ASODITECH Gestion E-commerce" };

const PLATFORM_ICON = { WOOCOMMERCE: Store, SHOPIFY: ShoppingBag } as const;

/**
 * Product *creation* always happens on the platform the product will
 * actually live on — ASODITECH is not a second WooCommerce/Shopify
 * product editor. See docs/adr/0017-product-management-boundary.md. This
 * page never renders an ASODITECH-native creation form; it only ever
 * points the operator at a real, currently-connected platform.
 */
export default async function NouveauProduitPage() {
  await requirePermission("products.create");
  const platforms = await getConnectedCommercePlatforms();

  return (
    <div>
      <PageHeader
        title="Ajouter un produit"
        breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: "Ajouter" }]}
        description="La création de produit se fait sur la plateforme e-commerce connectée — ASODITECH reste le centre de pilotage opérationnel (stock, commandes, livraison, finance)."
      />

      {platforms.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Aucune plateforme e-commerce connectée."
          description="Connectez WooCommerce ou Shopify pour pouvoir créer un produit depuis ASODITECH. Une fois connecté, « Ajouter un produit » vous enverra directement sur l'interface de création de la plateforme."
          action={
            <Button render={<Link href="/integrations" />}>
              <Plug className="size-4" />
              Configurer une intégration
            </Button>
          }
        />
      ) : (
        <div className={platforms.length === 1 ? "max-w-sm" : "grid gap-4 sm:grid-cols-2 max-w-xl"}>
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
                        title={`Ouvre l'administration ${platform.label} — soyez déjà connecté(e) à ${platform.label} dans ce navigateur, sinon une page de connexion s'affichera.`}
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
      )}

      {platforms.length > 0 && (
        <p className="mt-4 flex max-w-xl items-start gap-1.5 text-xs text-muted-foreground">
          <LogIn className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Ces boutons ouvrent l&apos;administration réelle de la plateforme, dans ce navigateur. Assurez-vous d&apos;être
            déjà connecté(e) à cette administration — sinon, la plateforme vous demandera de vous identifier.
            L&apos;adresse de connexion peut varier selon le site (par exemple une page de connexion personnalisée
            sur WordPress via une extension de sécurité).
          </span>
        </p>
      )}
    </div>
  );
}
