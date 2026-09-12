import { z } from "zod";
import { planFeaturesSchema } from "@/lib/entitlements/catalogue";

export const changeTenantPlanSchema = z.object({
  tenantId: z.string().trim().min(1),
  planCode: z.enum(["BUSINESS", "PRO"]),
});

export const updateSubscriptionStatusSchema = z.object({
  tenantId: z.string().trim().min(1),
  status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED"]),
});

/** Platform-admin plan-definition editing (`/platform/plans`) — the
 * centralized place prices/limits/features are declared, per
 * docs/adr/0035. `maxOrdersPerMonth`/`maxUsers`/`maxWarehouses` accept
 * an empty string as "unlimited" (`null`) — reserved for a future CUSTOM
 * plan; BUSINESS/PRO are always given a real number in the UI. */
const optionalPositiveInt = z
  .union([z.literal(""), z.coerce.number().int().positive()])
  .transform((v) => (v === "" ? null : v));

export const updatePlanSchema = z.object({
  planId: z.string().trim().min(1),
  name: z.string().trim().min(2).max(100),
  installationPriceMad: z.coerce.number().min(0),
  monthlyPriceMad: z.coerce.number().min(0),
  maxOrdersPerMonth: optionalPositiveInt,
  maxUsers: optionalPositiveInt,
  maxWarehouses: optionalPositiveInt,
  features: planFeaturesSchema,
});

export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
