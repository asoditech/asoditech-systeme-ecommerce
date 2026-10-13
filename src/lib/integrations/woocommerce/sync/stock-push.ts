import "server-only";

import { prisma } from "@/lib/prisma";
import { availableStockTotal } from "@/lib/inventory";
import type { WooCommerceClient } from "../client";
import type { InventoryOwner } from "../store-settings";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";

type ItemWithWarehouse = {
  id: string;
  tenantId: string;
  quantityOnHand: number;
  quantityReserved: number;
  warehouse: { type: "ENTREPOT" | "MAGASIN"; isActive: boolean; tenantId: string };
};

/**
 * Sellable stock to publish to the online storefront (Phase 32b business
 * rule — docs/adr/0020-stock-transfers.md §10): ONLY active-ENTREPOT
 * inventory feeds WooCommerce; MAGASIN stock never does. Also returns
 * which rows actually contributed, so a caller can stamp them with the
 * pushed quantity (the echo-loop guard — see reconcileStockFromProvider).
 *
 *  - no InventoryItem row at all → `sellable: null` → caller skips the
 *    push (preserve pre-32b behaviour for untracked products).
 *  - has inventory rows but zero active-ENTREPOT stock (everything is at a
 *    MAGASIN, or only at an inactive/retired ENTREPOT) → `0`, pushed so the
 *    storefront quantity goes to 0 instead of staying stale.
 *  - otherwise → sellable units summed across the active ENTREPOTs.
 */
function onlineSellableStock(items: ItemWithWarehouse[]): { sellable: number | null; contributingIds: string[] } {
  if (items.length === 0) return { sellable: null, contributingIds: [] };
  const entrepot = items.filter((i) => i.warehouse.type === "ENTREPOT" && i.warehouse.isActive);
  return { sellable: availableStockTotal(entrepot) ?? 0, contributingIds: entrepot.map((i) => i.id) };
}

/** Stamps the echo-loop guard (see reconcileStockFromProvider) on every
 * InventoryItem row that fed into a just-pushed number. Best-effort: a
 * failure here must not fail the push itself, which already happened. */
async function recordPushedQuantity(itemIds: string[], quantity: number): Promise<void> {
  if (itemIds.length === 0) return;
  try {
    await prisma.inventoryItem.updateMany({
      where: { id: { in: itemIds } },
      data: { lastPushedQuantity: quantity, lastPushedAt: new Date() },
    });
  } catch (error) {
    console.error("recordPushedQuantity() failed (non-fatal):", error);
  }
}

// ---------------------------------------------------------------------------
// Which unit may be pushed, and with which number — ONE rule for the bulk
// « Pousser le stock » and the automatic push after a local change.
// ---------------------------------------------------------------------------

/**
 * Why a unit's stock is NOT sent. Every refusal sends nothing — never a 0, never
 * another unit's number (the parent's for a variation, a sibling's, a stale one).
 */
export type StockPushRefusal =
  | "store_owns_inventory" // « Qui gère le stock ? » = the store: ASODITECH never overwrites it
  | "not_linked" // not (or no longer) a WooCommerce-imported unit
  | "invalid_remote_id" // the store id is not a plain positive integer
  | "ambiguous_link" // the same store id is held by several local units
  | "other_company" // a stock row / parent of another company (defence in depth over RLS)
  | "not_tracked" // stock tracking off for the product (a variation follows its parent's flag)
  | "variable_parent" // a variable product's stock lives on its variations only
  | "no_inventory_row"; // ASODITECH has no stock for it: unknown, never treated as 0

export type StockPushPlan =
  | { ok: true; wcProductId: number; wcVariationId?: number; sellable: number; contributingIds: string[] }
  | { ok: false; reason: StockPushRefusal };

const REFUSAL_NOTE: Record<StockPushRefusal, string> = {
  store_owns_inventory: "la boutique gère ce stock",
  not_linked: "pas lié à un produit WooCommerce",
  invalid_remote_id: "identifiant WooCommerce invalide",
  ambiguous_link: "identifiant WooCommerce partagé par plusieurs produits — à corriger",
  other_company: "données incohérentes",
  not_tracked: "suivi du stock désactivé",
  variable_parent: "produit variable : le stock est envoyé par variante",
  no_inventory_row: "aucun stock dans ASODITECH",
};

const NOTED_REFUSALS = new Set<StockPushRefusal>(["invalid_remote_id", "ambiguous_link", "other_company"]);

const REMOTE_ID = /^[1-9]\d{0,15}$/;
const remoteId = (externalId: string | null): number | null => (externalId && REMOTE_ID.test(externalId) ? Number(externalId) : null);

type PlanProduct = {
  id: string;
  tenantId: string;
  source: string;
  externalId: string | null;
  trackInventory: boolean;
  inventoryItems: ItemWithWarehouse[];
};
type PlanVariation = {
  tenantId: string;
  productId: string;
  source: string;
  externalId: string | null;
  inventoryItems: ItemWithWarehouse[];
};
/** Store ids held by more than one local WooCommerce product / variation of this company. */
type AmbiguousIds = { products: Set<string>; variations: Set<string> };

const foreignRows = (tenantId: string, items: ItemWithWarehouse[]) =>
  items.some((i) => i.tenantId !== tenantId || i.warehouse.tenantId !== tenantId);

function sellablePlan(items: ItemWithWarehouse[], wcProductId: number, wcVariationId?: number): StockPushPlan {
  const { sellable, contributingIds } = onlineSellableStock(items);
  if (sellable == null) return { ok: false, reason: "no_inventory_row" };
  return { ok: true, wcProductId, ...(wcVariationId !== undefined ? { wcVariationId } : {}), sellable, contributingIds };
}

/** A simple (non-variable) product: its own rows, to its own store id. */
function planProductPush(product: PlanProduct, variationCount: number, owner: InventoryOwner, ambiguous: AmbiguousIds): StockPushPlan {
  if (owner === "STORE") return { ok: false, reason: "store_owns_inventory" };
  if (product.source !== "WOOCOMMERCE" || !product.externalId) return { ok: false, reason: "not_linked" };
  const wcProductId = remoteId(product.externalId);
  if (wcProductId == null) return { ok: false, reason: "invalid_remote_id" };
  if (ambiguous.products.has(product.externalId)) return { ok: false, reason: "ambiguous_link" };
  if (foreignRows(product.tenantId, product.inventoryItems)) return { ok: false, reason: "other_company" };
  if (!product.trackInventory) return { ok: false, reason: "not_tracked" };
  if (variationCount > 0) return { ok: false, reason: "variable_parent" };
  return sellablePlan(product.inventoryItems, wcProductId);
}

/**
 * A variation: ONLY its own rows, to (its parent's store id, its own store id).
 * The parent is the variation's own FK parent — never looked up by SKU — and
 * must itself be a linked WooCommerce product; tracking is the parent's flag
 * (the model's one rule, src/lib/stock-validation.ts lineTrackInventory).
 */
function planVariationPush(variation: PlanVariation, parent: PlanProduct | null, owner: InventoryOwner, ambiguous: AmbiguousIds): StockPushPlan {
  if (owner === "STORE") return { ok: false, reason: "store_owns_inventory" };
  if (variation.source !== "WOOCOMMERCE" || !variation.externalId) return { ok: false, reason: "not_linked" };
  if (!parent || parent.id !== variation.productId || parent.source !== "WOOCOMMERCE" || !parent.externalId) return { ok: false, reason: "not_linked" };
  const wcProductId = remoteId(parent.externalId);
  const wcVariationId = remoteId(variation.externalId);
  if (wcProductId == null || wcVariationId == null) return { ok: false, reason: "invalid_remote_id" };
  if (wcProductId === wcVariationId || ambiguous.variations.has(variation.externalId) || ambiguous.products.has(parent.externalId)) {
    return { ok: false, reason: "ambiguous_link" };
  }
  if (parent.tenantId !== variation.tenantId || foreignRows(variation.tenantId, variation.inventoryItems)) return { ok: false, reason: "other_company" };
  if (!parent.trackInventory) return { ok: false, reason: "not_tracked" };
  return sellablePlan(variation.inventoryItems, wcProductId, wcVariationId);
}

async function ambiguousRemoteIds(filter?: { productExternalIds?: string[]; variationExternalIds?: string[] }): Promise<AmbiguousIds> {
  const [products, variations] = await Promise.all([
    prisma.product.groupBy({
      by: ["externalId"],
      where: { source: "WOOCOMMERCE", externalId: filter?.productExternalIds ? { in: filter.productExternalIds } : { not: null } },
      _count: { _all: true },
    }),
    prisma.productVariation.groupBy({
      by: ["externalId"],
      where: { source: "WOOCOMMERCE", externalId: filter?.variationExternalIds ? { in: filter.variationExternalIds } : { not: null } },
      _count: { _all: true },
    }),
  ]);
  const dup = (rows: { externalId: string | null; _count: { _all: number } }[]) =>
    new Set(rows.filter((r) => r.externalId && r._count._all > 1).map((r) => r.externalId as string));
  return { products: dup(products), variations: dup(variations) };
}

const itemInclude = { include: { warehouse: { select: { type: true, isActive: true, tenantId: true } } } } as const;

/**
 * The plan for ONE product or variation, read fresh from the database — what
 * the automatic push sends (or why it sends nothing). Exported for tests.
 */
export async function planWooCommerceStockPush(
  owner: { productId?: string; variationId?: string },
  inventoryOwner: InventoryOwner
): Promise<StockPushPlan> {
  if (inventoryOwner === "STORE") return { ok: false, reason: "store_owns_inventory" };
  if (owner.variationId) {
    const variation = await prisma.productVariation.findUnique({
      where: { id: owner.variationId },
      include: { inventoryItems: itemInclude, product: { include: { inventoryItems: itemInclude } } },
    });
    if (!variation) return { ok: false, reason: "not_linked" };
    const ambiguous = await ambiguousRemoteIds({
      productExternalIds: variation.product.externalId ? [variation.product.externalId] : [],
      variationExternalIds: variation.externalId ? [variation.externalId] : [],
    });
    return planVariationPush(variation, variation.product, inventoryOwner, ambiguous);
  }
  if (!owner.productId) return { ok: false, reason: "not_linked" };
  const product = await prisma.product.findUnique({
    where: { id: owner.productId },
    include: { inventoryItems: itemInclude, _count: { select: { variations: true } } },
  });
  if (!product) return { ok: false, reason: "not_linked" };
  const ambiguous = await ambiguousRemoteIds({ productExternalIds: product.externalId ? [product.externalId] : [], variationExternalIds: [] });
  return planProductPush(product, product._count.variations, inventoryOwner, ambiguous);
}

/**
 * System → WooCommerce (the "push" half — see docs/adr/0010-woocommerce-integration.md).
 * Only ever targets products/variations already linked to WooCommerce
 * (source=WOOCOMMERCE with a real externalId) — pushing a purely internal
 * product's stock to WooCommerce would require guessing which external
 * product it corresponds to, which this phase never does.
 *
 * The pushed quantity is *sellable* stock (`quantityOnHand -
 * quantityReserved`), never raw `quantityOnHand` — units already reserved
 * against a local order are spoken for and must not appear purchasable on
 * the storefront — and, since Phase 32b, restricted to active-ENTREPOT
 * locations (see onlineSellableStock). This does not write anything to the
 * internal database; nothing here changed on our side, so no
 * InventoryMovement is created.
 *
 * Each unit goes through the same plan as the automatic push
 * (planProductPush / planVariationPush): a variable product's variations
 * each get their OWN rows' number, a refused unit gets nothing and a note,
 * and one unit's failure never stops the others. When the company's store
 * manages the stock (`inventoryOwner: "STORE"`), nothing is sent at all.
 */
export async function pushStockToWooCommerce(
  client: WooCommerceClient,
  options: { inventoryOwner?: InventoryOwner } = {}
): Promise<SyncSummary> {
  const summary = emptySyncSummary();
  const inventoryOwner = options.inventoryOwner ?? "ASODITECH";
  if (inventoryOwner === "STORE") {
    recordNote(summary, "La boutique gère le stock des produits importés : ASODITECH n'y envoie aucun stock.");
    return summary;
  }

  const ambiguous = await ambiguousRemoteIds();
  const products = await prisma.product.findMany({
    where: { source: "WOOCOMMERCE", externalId: { not: null }, trackInventory: true },
    include: {
      inventoryItems: itemInclude,
      variations: { include: { inventoryItems: itemInclude } },
    },
  });

  const send = async (plan: StockPushPlan, label: string) => {
    if (!plan.ok) {
      // Anomalies the user must fix get a note; ordinary skips (no stock yet, untracked…) are only counted.
      if (NOTED_REFUSALS.has(plan.reason)) recordNote(summary, `${label} : stock non envoyé (${REFUSAL_NOTE[plan.reason]}).`);
      summary.skipped++;
      return;
    }
    try {
      await client.updateStock(plan.wcProductId, plan.sellable, plan.wcVariationId);
      summary.updated++;
      await recordPushedQuantity(plan.contributingIds, plan.sellable);
    } catch {
      recordNote(summary, `${label} : échec de l'envoi du stock à WooCommerce.`);
      summary.failed++;
    }
  };

  for (const product of products) {
    if (product.variations.length > 0) {
      for (const variation of product.variations) {
        await send(planVariationPush(variation, product, inventoryOwner, ambiguous), `Variation ${variation.sku}`);
      }
      continue;
    }
    await send(planProductPush(product, 0, inventoryOwner, ambiguous), `Produit ${product.sku}`);
  }

  return summary;
}

/**
 * Single-item counterpart to `pushStockToWooCommerce`, for the automatic
 * push after a local stock change (see pushStockAfterLocalChange) — one
 * product or variation, recomputed fresh from the database rather than
 * trusting a caller-supplied number, so it can never push a stale value.
 * Same plan as the batch push (planWooCommerceStockPush: ownership, link,
 * tracking, own rows only, active-ENTREPOT sellable stock) and the same
 * echo-loop guard stamp. Returns whether the push actually happened —
 * best-effort, never throws.
 */
export async function pushStockForWooCommerceOwner(
  client: WooCommerceClient,
  owner: { productId?: string; variationId?: string },
  options: { inventoryOwner?: InventoryOwner } = {}
): Promise<boolean> {
  try {
    const plan = await planWooCommerceStockPush(owner, options.inventoryOwner ?? "ASODITECH");
    if (!plan.ok) return false;
    await client.updateStock(plan.wcProductId, plan.sellable, plan.wcVariationId);
    await recordPushedQuantity(plan.contributingIds, plan.sellable);
    return true;
  } catch (error) {
    console.error("pushStockForWooCommerceOwner() failed (non-fatal):", error);
    return false;
  }
}
