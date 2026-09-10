"use server";

import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { syncWooCommerceOrdersAction, syncWooCommerceProductsAction } from "@/actions/woocommerce";
import { syncShopifyOrdersAction, syncShopifyProductsAction } from "@/actions/shopify";
import { isShopifyIntegrationEnabled } from "@/lib/integrations/shopify/feature-flag";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * One-click "sync whatever is connected" — powers the « Synchroniser »
 * button on the Commandes / Produits / Stock pages. Runs the relevant
 * pull (orders, or products+stock) for every CONNECTE WooCommerce /
 * Shopify integration and reports a short combined summary. Same
 * `integrations.manage` gate as the per-platform sync actions; a caller
 * without it (or with nothing connected) just gets a clear message and
 * the page still refreshes client-side.
 */
export interface CombinedSyncResult {
  ran: { platform: string; imported: number; updated: number; hasMore: boolean }[];
}

async function connectedProviders(): Promise<Set<"WOOCOMMERCE" | "SHOPIFY">> {
  // Shopify is disabled for now (client feedback #10) — never pull it,
  // even if a tenant had a CONNECTE Shopify row before it was disabled.
  const providers: ("WOOCOMMERCE" | "SHOPIFY")[] = isShopifyIntegrationEnabled()
    ? ["WOOCOMMERCE", "SHOPIFY"]
    : ["WOOCOMMERCE"];
  const rows = await prisma.integration.findMany({
    where: { provider: { in: providers }, status: "CONNECTE" },
    select: { provider: true },
  });
  return new Set(rows.map((r) => r.provider as "WOOCOMMERCE" | "SHOPIFY"));
}

async function run(
  resource: "orders" | "products"
): Promise<ActionResult<CombinedSyncResult>> {
  await requirePermissionForAction("integrations.manage");

  const connected = await connectedProviders();
  if (connected.size === 0) {
    return actionError("Aucune boutique connectée — rien à synchroniser.");
  }

  const ran: CombinedSyncResult["ran"] = [];
  const errors: string[] = [];

  const jobs: { platform: string; run: () => Promise<ActionResult<{ summary: { imported: number; updated: number; hasMore?: boolean } }>> }[] = [];
  if (connected.has("WOOCOMMERCE")) {
    jobs.push({
      platform: "WooCommerce",
      run: resource === "orders" ? syncWooCommerceOrdersAction : syncWooCommerceProductsAction,
    });
  }
  if (connected.has("SHOPIFY")) {
    jobs.push({
      platform: "Shopify",
      run: resource === "orders" ? syncShopifyOrdersAction : syncShopifyProductsAction,
    });
  }

  for (const job of jobs) {
    const res = await job.run();
    if (res.ok) {
      ran.push({
        platform: job.platform,
        imported: res.data.summary.imported,
        updated: res.data.summary.updated,
        hasMore: Boolean(res.data.summary.hasMore),
      });
    } else {
      errors.push(`${job.platform} : ${res.error}`);
    }
  }

  if (ran.length === 0) {
    return actionError(errors.join(" · ") || "La synchronisation a échoué.");
  }
  return actionOk({ ran });
}

export async function syncConnectedOrdersAction(): Promise<ActionResult<CombinedSyncResult>> {
  return run("orders");
}

export async function syncConnectedProductsAction(): Promise<ActionResult<CombinedSyncResult>> {
  return run("products");
}
