import { PackageSearch, Tag } from "lucide-react";
import { resolveScanToken } from "@/lib/catalog/labels";
import { Badge } from "@/components/ui/badge";
import { BrandMark } from "@/components/brand-mark";

export const metadata = { title: "Fiche produit" };

/**
 * Public QR-label landing page — docs/adr/0042. Reached by anyone scanning a
 * printed label, no account required (whitelisted in src/proxy.ts). Shows
 * ONLY the safe, public subset `resolveScanToken` selects: never cost,
 * price, supplier, or any other internal/tenant-sensitive field. An
 * invalid/unknown token renders the exact same "introuvable" page a
 * cross-tenant token would — the response never reveals whether a token is
 * simply wrong or belongs to someone else's catalog.
 */
export default async function ScanPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await resolveScanToken(token);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm">
        <div className="mb-6 flex justify-center">
          <BrandMark variant="wordmark" />
        </div>

        {!result ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <PackageSearch className="size-10 text-muted-foreground" />
            <p className="text-sm font-medium">Produit introuvable</p>
            <p className="text-xs text-muted-foreground">Ce code n&apos;est associé à aucun produit.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {result.imageUrl && (
              <div className="mx-auto aspect-square w-40 overflow-hidden rounded-lg border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant/WooCommerce/Shopify host, can't be allow-listed for next/image */}
                <img src={result.imageUrl} alt={result.productName} className="size-full object-cover" />
              </div>
            )}
            <div className="space-y-1 text-center">
              <h1 className="text-base font-semibold">{result.productName}</h1>
              {result.variantLabel && <p className="text-sm text-muted-foreground">{result.variantLabel}</p>}
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {result.categoryName && <Badge variant="outline">{result.categoryName}</Badge>}
              <Badge variant="secondary" className="font-mono">
                SKU {result.sku}
              </Badge>
            </div>
            {result.primaryBarcode && (
              <div className="flex items-center justify-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs">
                <Tag className="size-3.5 text-muted-foreground" />
                <span className="font-mono">{result.primaryBarcode}</span>
              </div>
            )}
            {result.companyName && (
              <p className="pt-2 text-center text-[11px] text-muted-foreground">{result.companyName}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
