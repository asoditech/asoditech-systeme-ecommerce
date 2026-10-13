import "server-only";

import type { RecordSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  missingCostProductWhere,
  missingCostSimpleProductWhere,
  missingCostVariationWhere,
  type MissingCostSummary,
} from "@/lib/catalog/missing-cost";

/**
 * How many sellable units of the CURRENT tenant lack a purchase cost, split by
 * where the product comes from (tenant-scoped `prisma` — never another
 * tenant's catalogue). See src/lib/catalog/missing-cost.ts for the rule.
 */
export async function getMissingCostSummary(): Promise<MissingCostSummary> {
  const [simple, variations, products] = await Promise.all([
    prisma.product.groupBy({ by: ["source"], where: missingCostSimpleProductWhere(), _count: true }),
    prisma.productVariation.findMany({ where: missingCostVariationWhere(), select: { product: { select: { source: true } } } }),
    prisma.product.count({ where: missingCostProductWhere() }),
  ]);
  const bySource: Record<RecordSource, number> = { INTERNE: 0, WOOCOMMERCE: 0, SHOPIFY: 0 };
  for (const g of simple) bySource[g.source] += g._count;
  for (const v of variations) bySource[v.product.source] += 1;
  const units = bySource.INTERNE + bySource.WOOCOMMERCE + bySource.SHOPIFY;
  return { units, products, bySource };
}
