import { z } from "zod";

export const updateBusinessSettingsSchema = z.object({
  companyName: z.string().trim().max(200).default(""),
  currency: z.string().length(3).default("MAD"),
  address: z.string().trim().max(500).nullish().or(z.literal("")),
  city: z.string().trim().max(120).nullish().or(z.literal("")),
  country: z.string().trim().max(120).default("Maroc"),
  phone: z.string().trim().max(30).nullish().or(z.literal("")),
  email: z.email().nullish().or(z.literal("")),
  timezone: z.string().trim().max(64).default("Africa/Casablanca"),
  lowStockDefaultThreshold: z.coerce.number().int().min(0).default(5),
  orderNumberPrefix: z.string().trim().min(1).max(10).default("CMD"),
});

export type UpdateBusinessSettingsInput = z.infer<typeof updateBusinessSettingsSchema>;
