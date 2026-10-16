import { z } from "zod";
import { BUSINESS_MODES } from "@/lib/tenant/business-mode";

// Matches Tenant.slug's real-world use as a URL/identifier fragment —
// lowercase, digits, hyphens, no leading/trailing hyphen.
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const createTenantSchema = z.object({
  name: z.string().trim().min(2, "Le nom est requis.").max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2, "L'identifiant doit contenir au moins 2 caractères.")
    .max(60)
    .regex(slugPattern, "Lettres minuscules, chiffres et tirets uniquement."),
  ownerName: z.string().trim().min(2, "Le nom du propriétaire est requis.").max(200),
  ownerEmail: z.email("Adresse e-mail invalide."),
  // docs/adr/0041 — defaults to the pre-existing product when omitted.
  businessMode: z.enum(BUSINESS_MODES).default("ONLINE_ONLY"),
});

export const setTenantBusinessModeSchema = z.object({
  tenantId: z.string().min(1),
  businessMode: z.enum(BUSINESS_MODES),
});

/** Platform grant of automatic customer codes (docs/adr/0060). */
export const setTenantCustomerBarcodeGrantSchema = z.object({
  tenantId: z.string().min(1),
  granted: z.enum(["true", "false"]).transform((v) => v === "true"),
});

/** Platform grant of the company's own logo in the app shell. */
export const setTenantBrandLogoGrantSchema = setTenantCustomerBarcodeGrantSchema;

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
