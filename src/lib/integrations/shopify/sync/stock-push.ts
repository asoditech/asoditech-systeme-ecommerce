import "server-only";

import { prisma } from "@/lib/prisma";
import { availableStock } from "@/lib/inventory";
import type { ShopifyClient } from "../client";
import { ShopifyUserError } from "../errors";
import { emptySyncSummary, recordNote, type SyncSummary } from "@/lib/integrations/shared";
import type { InventoryOwner } from "@/lib/integrations/woocommerce/store-settings";

const BATCH_SIZE = 25;

// ---------------------------------------------------------------------------
// Which stock row may be pushed, and with which number — ONE rule for the
// bulk « Pousser le stock » and the automatic push after a local change
// (same contract as WooCommerce's sync/stock-push.ts, adapted to Shopify's
// per-location model: one entry per (InventoryItem gid, Location gid) row).
// ---------------------------------------------------------------------------

/** Why a row's stock is NOT sent. A refused row sends nothing — never a 0, never another row's number. */
export type ShopifyStockPushRefusal =
  | "store_owns_inventory" // « Qui gère le stock ? » = the store
  | "not_linked" // the unit (or a variant's parent) is not a Shopify-imported one
  | "invalid_remote_id" // a gid that is not Shopify's own shape
  | "not_shopify_location" // the row's warehouse is not a Shopify location
  | "ambiguous_link" // the same Shopify inventory item / variant id is held by several local units
  | "other_company" // row, unit, parent or location of another company (defence in depth over RLS)
  | "not_tracked" // stock tracking off for the product (a variant follows its parent's flag)
  | "variable_parent" // a product with variants: its stock lives on the variants
  | "inactive_location"; // Shopify itself reports this location as deactivated (`isActive: false`)

export type ShopifyStockPushPlan =
  | { ok: true; entry: { inventoryItemId: string; locationId: string; quantity: number }; rowId: string; label: string }
  | { ok: false; reason: ShopifyStockPushRefusal };

const REFUSAL_NOTE: Record<ShopifyStockPushRefusal, string> = {
  store_owns_inventory: "la boutique gère ce stock",
  not_linked: "pas lié à un produit Shopify",
  invalid_remote_id: "identifiant Shopify invalide",
  not_shopify_location: "emplacement non lié à Shopify",
  ambiguous_link: "identifiant Shopify partagé par plusieurs articles — à corriger",
  other_company: "données incohérentes",
  not_tracked: "suivi du stock désactivé",
  variable_parent: "produit à variantes : le stock est envoyé par variante",
  inactive_location: "emplacement désactivé sur Shopify",
};
const NOTED_REFUSALS = new Set<ShopifyStockPushRefusal>(["invalid_remote_id", "ambiguous_link", "other_company", "inactive_location"]);

const gid = (kind: string) => new RegExp(`^gid://shopify/${kind}/[1-9]\\d{0,19}$`);
const GID = { product: gid("Product"), variant: gid("ProductVariant"), item: gid("InventoryItem"), location: gid("Location") };

type PlanUnit = { id: string; tenantId: string; source: string; externalId: string | null };
type PlanProduct = PlanUnit & { sku: string; trackInventory: boolean; _count: { variations: number } };
type PlanRow = {
  id: string;
  tenantId: string;
  warehouseId: string;
  externalId: string | null;
  quantityOnHand: number;
  quantityReserved: number;
  warehouse: { tenantId: string; source: string; externalId: string | null };
  product: PlanProduct | null;
  variation: (PlanUnit & { sku: string; productId: string; product: PlanProduct }) | null;
};
/** Shopify ids held by more than one local unit of this company. */
type Ambiguous = { items: Set<string>; variants: Set<string>; products: Set<string> };

const rowInclude = {
  warehouse: { select: { tenantId: true, source: true, externalId: true } },
  product: { include: { _count: { select: { variations: true } } } },
  variation: { include: { product: { include: { _count: { select: { variations: true } } } } } },
} as const;

/** The plan for ONE stock row (exported for tests). */
export function planShopifyRowPush(row: PlanRow, owner: InventoryOwner, ambiguous: Ambiguous): ShopifyStockPushPlan {
  if (owner === "STORE") return { ok: false, reason: "store_owns_inventory" };
  if (row.warehouse.source !== "SHOPIFY" || !row.warehouse.externalId) return { ok: false, reason: "not_shopify_location" };

  const parent = row.variation ? row.variation.product : row.product;
  if (!parent || parent.source !== "SHOPIFY" || !parent.externalId) return { ok: false, reason: "not_linked" };
  if (row.variation && (row.variation.source !== "SHOPIFY" || !row.variation.externalId)) return { ok: false, reason: "not_linked" };
  if (!row.externalId) return { ok: false, reason: "not_linked" };

  if (!GID.item.test(row.externalId) || !GID.location.test(row.warehouse.externalId) || !GID.product.test(parent.externalId)) {
    return { ok: false, reason: "invalid_remote_id" };
  }
  if (row.variation && !GID.variant.test(row.variation.externalId!)) return { ok: false, reason: "invalid_remote_id" };
  if (
    ambiguous.items.has(row.externalId) ||
    ambiguous.products.has(parent.externalId) ||
    (row.variation !== null && ambiguous.variants.has(row.variation.externalId!))
  ) {
    return { ok: false, reason: "ambiguous_link" };
  }
  const tenantIds = new Set([row.tenantId, row.warehouse.tenantId, parent.tenantId, ...(row.variation ? [row.variation.tenantId] : [])]);
  if (tenantIds.size !== 1) return { ok: false, reason: "other_company" };
  if (!parent.trackInventory) return { ok: false, reason: "not_tracked" };
  if (!row.variation && parent._count.variations > 0) return { ok: false, reason: "variable_parent" };

  // This row's own sellable units at this location: on hand − reserved (damaged
  // units are a separate bucket, never on hand — src/lib/inventory.ts).
  return {
    ok: true,
    rowId: row.id,
    label: row.variation?.sku ?? row.product?.sku ?? row.id,
    entry: { inventoryItemId: row.externalId, locationId: row.warehouse.externalId, quantity: availableStock(row) },
  };
}

async function ambiguousShopifyIds(): Promise<Ambiguous> {
  const [rows, variants, products] = await Promise.all([
    // One Shopify InventoryItem belongs to ONE variant: the same gid on rows of two different units is ambiguous.
    prisma.inventoryItem.findMany({
      where: { externalId: { not: null }, warehouse: { source: "SHOPIFY" } },
      select: { externalId: true, productId: true, variationId: true },
    }),
    prisma.productVariation.groupBy({ by: ["externalId"], where: { source: "SHOPIFY", externalId: { not: null } }, _count: { _all: true } }),
    prisma.product.groupBy({ by: ["externalId"], where: { source: "SHOPIFY", externalId: { not: null } }, _count: { _all: true } }),
  ]);
  const unitsByItem = new Map<string, Set<string>>();
  for (const r of rows) {
    const unit = r.variationId ? `v:${r.variationId}` : `p:${r.productId}`;
    const set = unitsByItem.get(r.externalId!) ?? new Set<string>();
    set.add(unit);
    unitsByItem.set(r.externalId!, set);
  }
  const dup = (groups: { externalId: string | null; _count: { _all: number } }[]) =>
    new Set(groups.filter((g) => g.externalId && g._count._all > 1).map((g) => g.externalId as string));
  return {
    items: new Set([...unitsByItem].filter(([, units]) => units.size > 1).map(([id]) => id)),
    variants: dup(variants),
    products: dup(products),
  };
}

/**
 * Locations Shopify ITSELF reports as deactivated (`isActive: false`, the field
 * the location sync already relies on). A location missing from the list is
 * NOT assumed inactive (deleted vs. not readable cannot be told apart here):
 * Shopify's own answer to the push then decides. Throws when the list cannot
 * be read — callers then send nothing.
 */
async function inactiveShopifyLocations(client: ShopifyClient): Promise<Set<string>> {
  const inactive = new Set<string>();
  for await (const page of client.listAllLocations()) {
    for (const location of page) if (!location.isActive) inactive.add(location.id);
  }
  return inactive;
}

/** The shared location guard: a planned row at a deactivated location is refused — never redirected elsewhere. */
function guardLocation(plan: ShopifyStockPushPlan, inactive: Set<string>): ShopifyStockPushPlan {
  return plan.ok && inactive.has(plan.entry.locationId) ? { ok: false, reason: "inactive_location" } : plan;
}

type Planned = Extract<ShopifyStockPushPlan, { ok: true }>;

/**
 * Sends planned rows in batches. When Shopify REJECTS a batch
 * (`ShopifyUserError` — its answer does not say which rows it applied), each
 * row of that batch is re-sent alone: `inventorySetQuantities` sets an
 * absolute quantity (never a delta), so re-sending a row that may already
 * have been applied writes the same number again, and each row's own answer
 * decides. Network, authentication, throttling or malformed answers are NOT
 * retried (the whole batch counts as failed). Only confirmed rows get their
 * « last pushed » stamp.
 */
async function sendPlanned(client: ShopifyClient, planned: Planned[]): Promise<{ succeeded: Planned[]; failed: Planned[]; rejectedBatches: number }> {
  const succeeded: Planned[] = [];
  const failed: Planned[] = [];
  let rejectedBatches = 0;
  for (let i = 0; i < planned.length; i += BATCH_SIZE) {
    const batch = planned.slice(i, i + BATCH_SIZE);
    try {
      await client.setInventoryQuantities(batch.map((p) => p.entry));
      succeeded.push(...batch);
      continue;
    } catch (error) {
      if (!(error instanceof ShopifyUserError) || batch.length === 1) {
        failed.push(...batch);
        continue;
      }
    }
    rejectedBatches++;
    for (const row of batch) {
      try {
        await client.setInventoryQuantities([row.entry]);
        succeeded.push(row);
      } catch {
        failed.push(row);
      }
    }
  }
  await recordPushedQuantities(succeeded);
  return { succeeded, failed, rejectedBatches };
}

/**
 * System → Shopify (the "push" half — see docs/adr/0011-shopify-integration.md).
 * Unlike WooCommerce (one global stock number per product), Shopify
 * tracks inventory per-location — this pushes one (inventoryItemId,
 * locationId, quantity) entry per (product/variation, Shopify-sourced
 * warehouse) row, never a collapsed number. Every row goes through
 * `planShopifyRowPush`: ownership (`inventoryOwner: "STORE"` → nothing at
 * all), link and gid shapes, tracking (a variant follows its parent's flag),
 * one unit per Shopify id, one company. A row is only ever pushed with its
 * OWN sellable quantity (`quantityOnHand − quantityReserved`); a unit
 * without a row is never sent anything (never a 0).
 *
 * Before sending, Shopify's own location list is read: a row at a location
 * it reports deactivated is refused (never redirected); if the list cannot
 * be read, nothing is sent. A batch Shopify rejects is re-sent row by row
 * (`sendPlanned`), so one bad row never fails the others.
 *
 * `inventorySetQuantities` sets quantities only — it never switches
 * Shopify's own « Suivre la quantité » on or off. This never writes to the
 * internal database's stock (no InventoryMovement).
 */
export async function pushStockToShopify(
  client: ShopifyClient,
  options: { inventoryOwner?: InventoryOwner } = {}
): Promise<SyncSummary> {
  const summary = emptySyncSummary();
  const inventoryOwner = options.inventoryOwner ?? "ASODITECH";
  if (inventoryOwner === "STORE") {
    recordNote(summary, "La boutique gère le stock des produits importés : ASODITECH n'y envoie aucun stock.");
    return summary;
  }

  const ambiguous = await ambiguousShopifyIds();
  const rows = await prisma.inventoryItem.findMany({
    where: { warehouse: { source: "SHOPIFY", externalId: { not: null } } },
    include: rowInclude,
  });
  const plans = rows.map((row) => ({ row, plan: planShopifyRowPush(row, inventoryOwner, ambiguous) }));
  if (!plans.some((p) => p.plan.ok)) {
    summary.skipped += plans.length;
    for (const { row, plan } of plans) noteRefusal(summary, row, plan);
    return summary;
  }

  let inactive: Set<string>;
  try {
    inactive = await inactiveShopifyLocations(client);
  } catch {
    recordNote(summary, "Impossible de vérifier les emplacements Shopify : aucun stock envoyé.");
    summary.failed += plans.filter((p) => p.plan.ok).length;
    summary.skipped += plans.filter((p) => !p.plan.ok).length;
    return summary;
  }

  const planned: Planned[] = [];
  for (const { row, plan: unguarded } of plans) {
    const plan = guardLocation(unguarded, inactive);
    if (plan.ok) {
      planned.push(plan);
      continue;
    }
    summary.skipped++;
    noteRefusal(summary, row, plan);
  }

  const { succeeded, failed, rejectedBatches } = await sendPlanned(client, planned);
  summary.updated += succeeded.length;
  summary.failed += failed.length;
  if (rejectedBatches > 0) recordNote(summary, `${rejectedBatches} lot(s) refusé(s) par Shopify : renvoyé(s) article par article.`);
  for (const row of failed) recordNote(summary, `Article ${row.label} : échec de l'envoi du stock à Shopify.`);

  return summary;
}

function noteRefusal(summary: SyncSummary, row: { id: string; product: { sku: string } | null; variation: { sku: string } | null }, plan: ShopifyStockPushPlan): void {
  if (plan.ok || !NOTED_REFUSALS.has(plan.reason)) return;
  const sku = row.variation?.sku ?? row.product?.sku ?? row.id;
  recordNote(summary, `Article ${sku} : stock non envoyé à Shopify (${REFUSAL_NOTE[plan.reason]}).`);
}

/** Stamps the echo-loop guard (see reconcileStockFromProvider) on exactly the
 * rows just pushed — by row id: the same Shopify InventoryItem gid sits on one
 * row per location, each with its own number. Best-effort: a failure here
 * must not fail the push itself, which already happened. */
async function recordPushedQuantities(planned: { entry: { quantity: number }; rowId: string }[]): Promise<void> {
  if (planned.length === 0) return;
  try {
    const now = new Date();
    await Promise.all(
      planned.map((p) => prisma.inventoryItem.update({ where: { id: p.rowId }, data: { lastPushedQuantity: p.entry.quantity, lastPushedAt: now } }))
    );
  } catch (error) {
    console.error("recordPushedQuantities() failed (non-fatal):", error);
  }
}

/**
 * The plans for every Shopify-location row of ONE product or variation, read
 * fresh (exported for tests). `inactiveLocations`: the push passes the
 * locations Shopify reports deactivated (shared guard with the bulk push).
 */
export async function planShopifyStockPush(
  owner: { productId?: string; variationId?: string },
  inventoryOwner: InventoryOwner,
  inactiveLocations: Set<string> = new Set()
): Promise<ShopifyStockPushPlan[]> {
  if (!owner.variationId && !owner.productId) return [];
  if (inventoryOwner === "STORE") return [{ ok: false, reason: "store_owns_inventory" }];
  const rows = await prisma.inventoryItem.findMany({
    where: {
      ...(owner.variationId ? { variationId: owner.variationId } : { productId: owner.productId! }),
      warehouse: { source: "SHOPIFY", externalId: { not: null } },
    },
    include: rowInclude,
  });
  if (rows.length === 0) return [];
  const ambiguous = await ambiguousShopifyIds();
  return rows.map((row) => guardLocation(planShopifyRowPush(row, inventoryOwner, ambiguous), inactiveLocations));
}

/**
 * Single-owner counterpart to `pushStockToShopify`, for the automatic
 * push after a local stock change (see pushStockAfterLocalChange) — the
 * same per-row plan, for every Shopify-location row of one product or
 * variation, recomputed fresh from the database, with the same location
 * guard and the same per-row fallback (`sendPlanned`). Returns whether
 * anything was actually pushed — best-effort, never throws.
 */
export async function pushStockForShopifyOwner(
  client: ShopifyClient,
  owner: { productId?: string; variationId?: string },
  options: { inventoryOwner?: InventoryOwner } = {}
): Promise<boolean> {
  try {
    const inventoryOwner = options.inventoryOwner ?? "ASODITECH";
    // Nothing pushable → no Shopify call at all (not even the location check).
    if (!(await planShopifyStockPush(owner, inventoryOwner)).some((p) => p.ok)) return false;
    const inactive = await inactiveShopifyLocations(client); // throws → nothing sent
    const planned = (await planShopifyStockPush(owner, inventoryOwner, inactive)).filter((p): p is Planned => p.ok);
    if (planned.length === 0) return false;
    const { succeeded } = await sendPlanned(client, planned);
    return succeeded.length > 0;
  } catch (error) {
    console.error("pushStockForShopifyOwner() failed (non-fatal):", error);
    return false;
  }
}
