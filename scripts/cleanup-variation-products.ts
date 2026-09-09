/**
 * One-off cleanup: remove standalone `Product` rows that were wrongly
 * created from a WooCommerce/Shopify VARIATION save.
 *
 * Background: before the fix in `src/app/api/webhooks/woocommerce/route.ts`
 * (+ `syncOneProduct`'s `type === "variation"` guard), a WooCommerce
 * `product.updated` webhook fired for a variation save would slip past
 * `wcProductSchema` and import the variation as its own catalogue product
 * (name "Parent - Red", SKU "WC-<variationId>"), duplicating the real
 * `ProductVariation` row. This scrubs those duplicates.
 *
 * A row is "bogus" when its `(source, externalId)` also exists as a
 * `ProductVariation`, it has no variations of its own, and — for safety —
 * no sold order lines (those keep their name/sku/cost snapshot regardless,
 * but we still report rather than delete them).
 *
 * Idempotent. Safe to re-run. Run AFTER deploying the webhook fix, then
 * run "Synchroniser les produits" once so the ongoing self-heal in
 * `syncVariationsForProduct` takes over.
 *
 * Usage:
 *   npx dotenv -e .env -- tsx scripts/cleanup-variation-products.ts --dry-run
 *   npx dotenv -e .env -- tsx scripts/cleanup-variation-products.ts
 */
import { prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  await runUnscoped("script:cleanup-variation-products", async () => {
    const variationKeys = await prismaBase.productVariation.findMany({
      where: { source: { in: ["WOOCOMMERCE", "SHOPIFY"] }, externalId: { not: null } },
      select: { source: true, externalId: true },
    });

    // group externalIds by source
    const bySource = new Map<string, Set<string>>();
    for (const v of variationKeys) {
      if (!v.externalId) continue;
      const set = bySource.get(v.source) ?? new Set<string>();
      set.add(v.externalId);
      bySource.set(v.source, set);
    }

    let deleted = 0;
    let kept = 0;
    let scanned = 0;

    for (const [source, ids] of bySource) {
      const suspects = await prismaBase.product.findMany({
        where: { source: source as "WOOCOMMERCE" | "SHOPIFY", externalId: { in: [...ids] } },
        select: {
          id: true,
          name: true,
          sku: true,
          tenantId: true,
          _count: { select: { orderItems: true, variations: true } },
        },
      });

      for (const p of suspects) {
        scanned++;
        if (p._count.variations > 0) {
          // Real parent product that happens to share an id space — skip.
          continue;
        }
        if (p._count.orderItems > 0) {
          kept++;
          console.log(
            `KEEP  [${source}] ${p.name} (${p.sku}) — ${p._count.orderItems} ligne(s) de commande. À fusionner manuellement.`
          );
          continue;
        }
        deleted++;
        console.log(`${dryRun ? "WOULD DELETE" : "DELETE"} [${source}] ${p.name} (${p.sku})`);
        if (!dryRun) {
          // InventoryItem.product / ProductImage.product are onDelete:Cascade;
          // OrderItem.product is onDelete:SetNull (none here anyway).
          await prismaBase.product.delete({ where: { id: p.id } });
        }
      }
    }

    console.log(
      `\n${scanned} suspect row(s) scanned — ${deleted} ${dryRun ? "to delete" : "deleted"}, ${kept} kept (have order history).`
    );
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prismaBase.$disconnect());
