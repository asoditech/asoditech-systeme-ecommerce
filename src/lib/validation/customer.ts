import { z } from "zod";

export const customerSegmentSchema = z.enum(["NOUVEAU", "ACTIF", "FIDELE", "A_RISQUE", "INACTIF", "VIP"]);

export const createCustomerSchema = z.object({
  fullName: z.string().trim().min(2, "Le nom complet est requis.").max(200),
  phone: z.string().trim().max(30).nullish().or(z.literal("")),
  whatsapp: z.string().trim().max(30).nullish().or(z.literal("")),
  email: z.email("Adresse e-mail invalide.").nullish().or(z.literal("")),
  city: z.string().trim().max(120).nullish().or(z.literal("")),
  region: z.string().trim().max(120).nullish().or(z.literal("")),
  country: z.string().trim().max(120).default("Maroc"),
  notes: z.string().trim().max(5000).nullish().or(z.literal("")),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});

export const updateCustomerSchema = createCustomerSchema.extend({
  id: z.string().min(1),
  segment: customerSegmentSchema.nullish(),
});

export const createCustomerAddressSchema = z.object({
  customerId: z.string().min(1),
  label: z.string().trim().max(100).nullish().or(z.literal("")),
  addressLine1: z.string().trim().min(2, "L'adresse est requise.").max(255),
  addressLine2: z.string().trim().max(255).nullish().or(z.literal("")),
  city: z.string().trim().min(1, "La ville est requise.").max(120),
  region: z.string().trim().max(120).nullish().or(z.literal("")),
  country: z.string().trim().max(120).default("Maroc"),
  phone: z.string().trim().max(30).nullish().or(z.literal("")),
  isDefault: z.coerce.boolean().default(false),
});

export const updateCustomerAddressSchema = createCustomerAddressSchema.extend({
  id: z.string().min(1),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
