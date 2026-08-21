import "server-only";

import { reconcileStockFromProvider, type SyncActor } from "@/lib/integrations/shared";

/**
 * WooCommerce → System stock reconciliation. Thin wrapper over the
 * provider-agnostic implementation (extracted during Phase 21 — see
 * src/lib/integrations/shared/stock-reconcile.ts) — kept as its own named
 * export here since existing call sites in this module import it by this
 * name. See docs/adr/0010-woocommerce-integration.md.
 */
export async function reconcileStockFromWooCommerce(params: {
  productId?: string;
  variationId?: string;
  warehouseId: string;
  externalQuantity: number;
  actor: SyncActor;
}): Promise<"created" | "reconciled" | "unchanged"> {
  return reconcileStockFromProvider({ ...params, source: "WOOCOMMERCE" });
}
