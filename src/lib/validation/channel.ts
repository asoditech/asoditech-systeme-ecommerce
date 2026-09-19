import { z } from "zod";

export const salesChannelKindSchema = z.enum(["ONLINE", "OFFLINE"]);

export const createSalesChannelSchema = z.object({
  name: z.string().trim().min(2, "Le nom du canal est requis.").max(100),
  kind: salesChannelKindSchema,
  // Physical locations the channel sells/fulfils from (no quantity — a mapping).
  warehouseIds: z.array(z.string().min(1)).max(200).default([]),
});
export type CreateSalesChannelInput = z.infer<typeof createSalesChannelSchema>;

export const updateSalesChannelSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Le nom du canal est requis.").max(100),
  isActive: z.boolean(),
});
export type UpdateSalesChannelInput = z.infer<typeof updateSalesChannelSchema>;

export const setChannelLocationsSchema = z.object({
  id: z.string().min(1),
  warehouseIds: z.array(z.string().min(1)).max(200),
});
export type SetChannelLocationsInput = z.infer<typeof setChannelLocationsSchema>;
