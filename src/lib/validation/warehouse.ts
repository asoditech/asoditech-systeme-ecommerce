import { z } from "zod";

/**
 * Warehouse (stock location) validation — Phase 32a
 * (docs/adr/0019-inventory-foundation.md). `type` distinguishes a
 * back-office warehouse from a retail store; both hold stock through the
 * same per-`(warehouse, product|variation)` InventoryItem rows.
 */
export const warehouseTypeSchema = z.enum(["ENTREPOT", "MAGASIN"]);

export const createWarehouseSchema = z.object({
  name: z.string().trim().min(2, "Le nom de l'emplacement est requis.").max(120),
  type: warehouseTypeSchema.default("ENTREPOT"),
  address: z.string().trim().max(255).nullish().or(z.literal("")),
});

export const updateWarehouseSchema = createWarehouseSchema.extend({
  id: z.string().min(1),
});

export const warehouseIdSchema = z.object({ id: z.string().min(1) });

export const setWarehouseActiveSchema = z.object({
  id: z.string().min(1),
  // Explicit "true"/"false" from a hidden field — NOT z.coerce.boolean(),
  // which turns the string "false" into `true`.
  isActive: z.enum(["true", "false"]).transform((v) => v === "true"),
});
