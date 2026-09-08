import { z } from "zod";

/**
 * The company logo, shown on printed reports and delivery invoices.
 * Accepts either an https URL or an inline `data:image/...;base64,` URI
 * (the settings form resizes a picked file to a small PNG data URI so no
 * external image hosting is needed). Capped at ~1.5 MB so a data URI
 * can't bloat every settings read.
 */
const logoUrlSchema = z
  .string()
  .trim()
  .max(1_500_000)
  .refine(
    (v) => v === "" || v.startsWith("https://") || v.startsWith("data:image/"),
    "Le logo doit être une URL https ou une image importée."
  )
  .nullish()
  .or(z.literal(""));

export const updateBusinessSettingsSchema = z.object({
  companyName: z.string().trim().max(200).default(""),
  currency: z.string().length(3).default("MAD"),
  logoUrl: logoUrlSchema,
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
