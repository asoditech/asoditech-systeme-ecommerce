import "server-only";

import { prisma } from "@/lib/prisma";
import { recordNote, type SyncSummary } from "@/lib/integrations/shared/sync-summary";

/** Shared rule (WooCommerce + Shopify): local variations of `productId` from `source` whose store id is not in `presentIds` → isActive false. */
export async function deactivateRemovedVariations(
  productId: string,
  source: "WOOCOMMERCE" | "SHOPIFY",
  presentIds: readonly string[],
  summary: SyncSummary
): Promise<number> {
  const { count } = await prisma.productVariation.updateMany({
    where: { productId, source, isActive: true, externalId: { not: null, notIn: [...new Set(presentIds)] } },
    data: { isActive: false },
  });
  if (count > 0) {
    recordNote(summary, `${count} variation(s) supprimée(s) dans la boutique : désactivée(s) ici (historique conservé).`);
  }
  return count;
}
