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
  ran: { platform: string; imported: number; updated: number; skipped: number; failed: number; hasMore: boolean; notes: string[] }[];
  errors: string[];
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

const PLATFORMS = ["WooCommerce", "Shopify"] as const;

async function run(
  resource: "orders" | "products",
  onlyPlatforms?: readonly string[]
): Promise<ActionResult<CombinedSyncResult>> {
  await requirePermissionForAction("integrations.manage");

  const connected = await connectedProviders();
  // The client's follow-up calls (« (suite…) ») only re-run the platforms
  // that still had more to do; unknown names are ignored.
  const only = Array.isArray(onlyPlatforms)
    ? new Set(onlyPlatforms.filter((p): p is (typeof PLATFORMS)[number] => (PLATFORMS as readonly string[]).includes(p)))
    : null;
  if (connected.size === 0) {
    return actionError("Aucune boutique connectée — rien à synchroniser.");
  }

  const ran: CombinedSyncResult["ran"] = [];
  const errors: string[] = [];

  const jobs: {
    platform: string;
    run: () => Promise<ActionResult<{ summary: { imported: number; updated: number; skipped: number; failed: number; notes: string[]; hasMore?: boolean } }>>;
  }[] = [];
  if (connected.has("WOOCOMMERCE") && (!only || only.has("WooCommerce"))) {
    jobs.push({
      platform: "WooCommerce",
      run: resource === "orders" ? syncWooCommerceOrdersAction : syncWooCommerceProductsAction,
    });
  }
  if (connected.has("SHOPIFY") && (!only || only.has("Shopify"))) {
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
        skipped: res.data.summary.skipped,
        failed: res.data.summary.failed,
        hasMore: Boolean(res.data.summary.hasMore),
        notes: res.data.summary.notes.slice(0, 3),
      });
    } else {
      errors.push(`${job.platform} : ${res.error}`);
    }
  }

  if (ran.length === 0) {
    return actionError(errors.join(" · ") || "La synchronisation a échoué.");
  }
  return actionOk({ ran, errors });
}

export async function syncConnectedOrdersAction(onlyPlatforms?: string[]): Promise<ActionResult<CombinedSyncResult>> {
  return run("orders", onlyPlatforms);
}

export async function syncConnectedProductsAction(onlyPlatforms?: string[]): Promise<ActionResult<CombinedSyncResult>> {
  return run("products", onlyPlatforms);
}
