import { z } from "zod";

/**
 * Two per-company choices of a WooCommerce connection, stored like its other
 * non-secret settings on `Integration.config` (one row per tenant + provider,
 * written key by key with `patchIntegrationConfig`) — no schema change, no
 * global switch. Independent of each other: neither is ever inferred from
 * the other.
 *
 * Both readers fail safe: a missing, unknown or malformed value is the
 * default, so existing companies keep exactly today's behaviour until an
 * authorised user explicitly changes it.
 */

/**
 * « Que faire lorsqu'un produit est supprimé de la boutique ? »
 * - `manual` (default): flag the product and notify; an authorised user
 *   confirms the unlinking from the product page.
 * - `auto`: unlink by itself, but ONLY once the store has confirmed the
 *   product no longer exists (src/lib/integrations/woocommerce/remote-deletion.ts).
 */
export const REMOTE_DELETION_MODES = ["manual", "auto"] as const;
export type RemoteDeletionMode = (typeof REMOTE_DELETION_MODES)[number];
export const remoteDeletionModeSchema = z.enum(REMOTE_DELETION_MODES);

export function remoteDeletionModeOf(config: unknown): RemoteDeletionMode {
  const value = config && typeof config === "object" ? (config as { remoteDeletionMode?: unknown }).remoteDeletionMode : undefined;
  return value === "auto" ? "auto" : "manual";
}

/**
 * « Qui gère le stock des produits importés ? »
 * - `ASODITECH` (default — docs/adr/0036: ASODITECH's InventoryItem is the
 *   only stock authority; the store's quantity may only initialize a row
 *   ASODITECH has never seen, then ASODITECH pushes its stock to the store).
 * - `STORE`: products imported from now on get no ASODITECH stock row, so
 *   ASODITECH neither reserves, consumes nor pushes stock for them — the
 *   store keeps managing its own quantity.
 * Governs what the NEXT imports create; existing stock rows are never
 * deleted, zeroed or rewritten by changing it.
 */
export const INVENTORY_OWNERS = ["ASODITECH", "STORE"] as const;
export type InventoryOwner = (typeof INVENTORY_OWNERS)[number];
export const inventoryOwnerSchema = z.enum(INVENTORY_OWNERS);

export function inventoryOwnerOf(config: unknown): InventoryOwner {
  const value = config && typeof config === "object" ? (config as { inventoryOwner?: unknown }).inventoryOwner : undefined;
  return value === "STORE" ? "STORE" : "ASODITECH";
}
