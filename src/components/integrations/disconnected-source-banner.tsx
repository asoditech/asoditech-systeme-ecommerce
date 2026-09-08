import Link from "next/link";
import { PlugZap } from "lucide-react";
import { prisma } from "@/lib/prisma";
import type { RecordSource } from "@prisma/client";

/**
 * Shown at the top of Produits / Commandes when a commerce integration is
 * disconnected but records it imported are still in the workspace.
 *
 * We deliberately never delete imported products or orders on disconnect
 * — they carry stock history, order lines, delivery and financial records
 * (the project's Data Integrity Principle). This just makes the state
 * explicit so an operator isn't confused about why "WooCommerce" rows are
 * still there and no longer updating.
 */
export async function DisconnectedSourceBanner({ entity }: { entity: "product" | "order" }) {
  const disconnected = await prisma.integration.findMany({
    where: { provider: { in: ["WOOCOMMERCE", "SHOPIFY"] }, status: "DECONNECTE" },
    select: { provider: true },
  });
  if (disconnected.length === 0) return null;

  const sources = disconnected.map((d) => d.provider) as RecordSource[];
  const counts = await (entity === "product"
    ? prisma.product.count({ where: { source: { in: sources } } })
    : prisma.order.count({ where: { source: { in: sources } } }));
  if (counts === 0) return null;

  const names = sources.map((s) => (s === "WOOCOMMERCE" ? "WooCommerce" : "Shopify")).join(" et ");
  const noun = entity === "product" ? "produits importés" : "commandes importées";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
      <PlugZap className="size-4 shrink-0" />
      <span>
        {names} {sources.length > 1 ? "sont déconnectés" : "est déconnecté"}. Les {counts} {noun} restent visibles pour
        l&apos;historique mais ne se synchronisent plus.
      </span>
      <Link href="/integrations" className="font-medium underline">
        Reconnecter
      </Link>
    </div>
  );
}
