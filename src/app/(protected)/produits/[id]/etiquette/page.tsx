import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePermission } from "@/lib/auth/guards";
import { requireCapability } from "@/lib/auth/capabilities";
import { prisma } from "@/lib/prisma";
import { ensureProductQrToken, ensureVariationQrToken, scanUrl } from "@/lib/catalog/labels";
import { variantLabel } from "@/lib/catalog/lookup";
import { PrintableLabel } from "@/components/products/printable-label";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Étiquette produit — ASODITECH Gestion E-commerce" };

/**
 * The printable label — docs/adr/0042. Reached only from "Imprimer
 * l'étiquette" in the product's Identité tab, never linked from anywhere
 * else: this is also where the QR token is generated, lazily, the first
 * time a label is actually requested (never for a whole catalog at once).
 * `?variation=<id>` prints ONE variation's label; without it, the
 * product's own (only valid when the product has no variations to speak
 * for — the Identité tab never links here without it for a variable
 * product).
 */
export default async function ProductLabelPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ variation?: string }>;
}) {
  const user = await requirePermission("products.edit");
  requireCapability(user, "catalogIdentity");
  const { id } = await params;
  const { variation: variationId } = await searchParams;

  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      sku: true,
      barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
      variations: {
        where: variationId ? { id: variationId } : undefined,
        select: { id: true, sku: true, attributes: true, barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 } },
      },
    },
  });
  if (!product) notFound();

  const variation = variationId ? product.variations.find((v) => v.id === variationId) : null;
  if (variationId && !variation) notFound(); // the variation id didn't belong to this product

  const token = variation ? await ensureVariationQrToken(variation.id) : await ensureProductQrToken(product.id);
  const barcode = (variation ? variation.barcodes[0] : product.barcodes[0])?.code ?? null;

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <div className="print:hidden">
        <Button variant="ghost" size="sm" render={<Link href={`/produits/${product.id}?tab=identite`} />}>
          <ArrowLeft className="size-4" />
          Retour au produit
        </Button>
      </div>
      <PrintableLabel
        productName={product.name}
        variantLabel={variation ? variantLabel(variation.attributes as Record<string, string>) : null}
        sku={variation ? variation.sku : product.sku}
        barcode={barcode}
        scanUrl={scanUrl(token)}
      />
    </div>
  );
}
