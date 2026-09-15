import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Keeps a product's lead (`position: 0`) `ProductImage` row in sync with
 * whatever WooCommerce/Shopify reports as its image, mirroring the same
 * "provider-owned, overwritten every sync" rule already applied to
 * name/sku/price/etc. for these sources (docs/adr/0010, docs/adr/0011).
 *
 * Only ever touches the lead image — never the whole gallery, and never a
 * product's other, non-position-0 images (there are none yet; this app
 * doesn't sync a full gallery, only the one preview-worthy photo). Called
 * with `imageUrl: null` when the provider currently reports no image at
 * all, which removes ASODITECH's own lead image too — the provider stays
 * the single source of truth for it, same as for name/price.
 *
 * Deliberately NOT used for an INTERNE (source-less) product — those get
 * their image from the manual "Ajouter une image" field on the product
 * page instead, which this function must never silently overwrite.
 */
export async function syncProductLeadImage(
  productId: string,
  imageUrl: string | null,
  altText?: string | null
): Promise<void> {
  const existing = await prisma.productImage.findFirst({
    where: { productId, position: 0 },
    select: { id: true, url: true, altText: true },
  });

  if (!imageUrl) {
    if (existing) await prisma.productImage.delete({ where: { id: existing.id } });
    return;
  }

  if (!existing) {
    await prisma.productImage.create({ data: { productId, url: imageUrl, altText: altText ?? null, position: 0 } });
    return;
  }

  if (existing.url !== imageUrl || existing.altText !== (altText ?? null)) {
    await prisma.productImage.update({
      where: { id: existing.id },
      data: { url: imageUrl, altText: altText ?? null },
    });
  }
}
