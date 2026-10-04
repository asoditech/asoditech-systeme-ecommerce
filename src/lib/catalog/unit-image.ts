/**
 * The image to show for one sellable unit (a simple product, or one
 * variation): the variation's own image (`ProductVariation.imageUrl`) when it
 * has one, otherwise the first available product gallery image
 * (`ProductImage`, position order). Pure, client-safe; no image is stored or
 * copied — it only chooses between the two existing sources.
 */
export function unitImageUrl(
  variation: { imageUrl?: string | null } | null | undefined,
  ...productImageUrls: (string | null | undefined)[]
): string | null {
  const own = variation?.imageUrl?.trim();
  if (own) return own;
  for (const url of productImageUrls) {
    const u = url?.trim();
    if (u) return u;
  }
  return null;
}
