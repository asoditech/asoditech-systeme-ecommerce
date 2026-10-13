import Link from "next/link";
import { CircleDollarSign } from "lucide-react";
import { userHasPermission } from "@/lib/auth/permissions";
import type { CurrentUser } from "@/lib/auth/session";
import { missingCostMessage } from "@/lib/catalog/missing-cost";
import { MISSING_COST_PRODUCTS_HREF } from "@/lib/catalog/missing-cost-routes";
import { getMissingCostSummary } from "@/lib/queries/missing-cost";

const SOURCE_LABELS = { INTERNE: "créés ici", WOOCOMMERCE: "WooCommerce", SHOPIFY: "Shopify" } as const;

/**
 * Persistent « coût d'achat manquant » warning, on every page listed in
 * MISSING_COST_BANNER_ROUTES (src/lib/catalog/missing-cost-routes.ts: the
 * dashboard, products, integrations, stock, finance, analyses and the
 * cost-dependent reports). Shown while at least one sellable unit has no purchase
 * cost — it disappears by itself once every cost is entered; nothing to
 * dismiss, nothing invented. In the page content (normal flow), so it never
 * covers the sticky header or the announcement bar.
 *
 * Only for `finance.view`: the purchase cost is finance data and only that
 * permission may set it (src/actions/products.ts COST_FORBIDDEN) — telling
 * anyone else to fix it would be a dead end.
 */
export async function MissingCostBanner({ user, showLink = true }: { user: Pick<CurrentUser, "permissions">; showLink?: boolean }) {
  if (!userHasPermission(user, "finance.view")) return null;
  const summary = await getMissingCostSummary();
  const message = missingCostMessage(summary);
  if (!message) return null;
  const detail = (Object.keys(SOURCE_LABELS) as (keyof typeof SOURCE_LABELS)[])
    .filter((s) => summary.bySource[s] > 0)
    .map((s) => `${summary.bySource[s]} ${SOURCE_LABELS[s]}`)
    .join(" · ");

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300 print:hidden"
    >
      <CircleDollarSign className="size-4 shrink-0" aria-hidden="true" />
      <span>
        {message} <span className="text-xs opacity-80">({detail})</span>
      </span>
      {showLink && (
        <Link href={MISSING_COST_PRODUCTS_HREF} className="font-medium underline">
          Voir les produits concernés
        </Link>
      )}
    </div>
  );
}
