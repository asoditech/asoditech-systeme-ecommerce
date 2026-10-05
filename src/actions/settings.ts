"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import {
  updateBusinessSettingsSchema,
  updateCostingMethodSchema,
  updateDefaultShippingProviderSchema,
  updateSellerPriceOverrideSchema,
} from "@/lib/validation/settings";
import { requireCapabilityForAction } from "@/lib/auth/capabilities";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { BusinessSettings } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function updateBusinessSettingsAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");

  const parsed = updateBusinessSettingsSchema.safeParse({
    companyName: formData.get("companyName") || "",
    currency: formData.get("currency") || "MAD",
    logoUrl: formData.get("logoUrl"),
    address: formData.get("address"),
    city: formData.get("city"),
    country: formData.get("country") || "Maroc",
    phone: formData.get("phone"),
    email: formData.get("email"),
    timezone: formData.get("timezone") || "Africa/Casablanca",
    lowStockDefaultThreshold: formData.get("lowStockDefaultThreshold") || 5,
    orderNumberPrefix: formData.get("orderNumberPrefix") || "CMD",
    supportName: formData.get("supportName"),
    supportWhatsapp: formData.get("supportWhatsapp"),
    supportPhone: formData.get("supportPhone"),
    supportEmail: formData.get("supportEmail"),
    supportHours: formData.get("supportHours"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // Phase 3 (docs/adr/0025): BusinessSettings is tenant-scoped, not a
  // global singleton — looked up/created by `tenantId`, never the old
  // fixed `id: "singleton"` (which now belongs only to the bootstrap
  // tenant's original row).
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: {
      companyName: parsed.data.companyName,
      currency: parsed.data.currency,
      logoUrl: normalizeOptional(parsed.data.logoUrl),
      address: normalizeOptional(parsed.data.address),
      city: normalizeOptional(parsed.data.city),
      country: parsed.data.country,
      phone: normalizeOptional(parsed.data.phone),
      email: normalizeOptional(parsed.data.email),
      timezone: parsed.data.timezone,
      lowStockDefaultThreshold: parsed.data.lowStockDefaultThreshold,
      orderNumberPrefix: parsed.data.orderNumberPrefix,
      supportName: normalizeOptional(parsed.data.supportName),
      supportWhatsapp: normalizeOptional(parsed.data.supportWhatsapp),
      supportPhone: normalizeOptional(parsed.data.supportPhone),
      supportEmail: normalizeOptional(parsed.data.supportEmail),
      supportHours: normalizeOptional(parsed.data.supportHours),
    },
    create: {
      ...parsed.data,
      supportName: normalizeOptional(parsed.data.supportName),
      supportWhatsapp: normalizeOptional(parsed.data.supportWhatsapp),
      supportPhone: normalizeOptional(parsed.data.supportPhone),
      supportEmail: normalizeOptional(parsed.data.supportEmail),
      supportHours: normalizeOptional(parsed.data.supportHours),
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    newValue: { companyName: settings.companyName },
  });

  revalidatePath("/parametres");
  return actionOk(settings);
}

/**
 * Product costing (Phase 3 — Product Costing & Profitability input). Narrow,
 * independently-submittable action — same `settings.manage` gate and the
 * same tenant-scoped upsert-by-`tenantId` pattern as
 * `updateBusinessSettingsAction` above, kept separate so this one control
 * can be saved without resubmitting the whole company-info form (docs/adr/0017
 * precedent: a small, focused action for a narrow field set).
 *
 * This ONLY changes which method future VALIDATED receptions use to update
 * a product/variation's CURRENT cost (src/lib/receptions.ts). It never
 * touches existing Product.cost/ProductVariation.cost values, never
 * recalculates history, and never touches costSnapshot anywhere.
 */
export async function updateCostingMethodAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");

  const parsed = updateCostingMethodSchema.safeParse({
    costingMethod: formData.get("costingMethod"),
  });
  if (!parsed.success) {
    return actionError("Méthode de calcul du coût invalide.", parsed.error.flatten().fieldErrors);
  }

  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: { costingMethod: parsed.data.costingMethod },
    create: { costingMethod: parsed.data.costingMethod },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    newValue: { costingMethod: settings.costingMethod },
  });

  revalidatePath("/parametres");
  return actionOk(settings);
}

/**
 * « Autoriser les vendeurs magasin à modifier le prix » — company-wide. When
 * on, every user who may sell in store also gets `sales.override_price` in
 * their effective access (src/lib/auth/effective-access.ts); a per-user DENY
 * still wins, and `createSaleAction` keeps enforcing the permission on the
 * server. Only meaningful (and only accepted) in an Online + Offline company.
 */
export async function updateSellerPriceOverrideAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");
  requireCapabilityForAction(user, "offlineSales");
  const parsed = updateSellerPriceOverrideSchema.safeParse({ allowSellerPriceOverride: formData.get("allowSellerPriceOverride") });
  if (!parsed.success) return actionError("Valeur invalide.", parsed.error.flatten().fieldErrors);

  const previous = await prisma.businessSettings.findUnique({ where: { tenantId: user.tenantId }, select: { allowSellerPriceOverride: true } });
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: { allowSellerPriceOverride: parsed.data.allowSellerPriceOverride },
    create: { allowSellerPriceOverride: parsed.data.allowSellerPriceOverride },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    previousValue: { allowSellerPriceOverride: previous?.allowSellerPriceOverride ?? false },
    newValue: { allowSellerPriceOverride: settings.allowSellerPriceOverride },
  });
  revalidatePath("/parametres");
  revalidatePath("/ventes/nouvelle");
  return actionOk(settings);
}

/**
 * « Transporteur par défaut » — ONLY decides whose city list is suggested on
 * the online order/customer forms when several delivery companies are active
 * (src/lib/queries/delivery-cities.ts). The shipment's provider is still
 * chosen at shipment creation. Must be an ACTIVE provider of this company;
 * "" clears it.
 */
export async function updateDefaultShippingProviderAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");
  const parsed = updateDefaultShippingProviderSchema.safeParse({ defaultShippingProviderId: formData.get("defaultShippingProviderId") });
  if (!parsed.success) return actionError("Transporteur invalide.", parsed.error.flatten().fieldErrors);
  const providerId = parsed.data.defaultShippingProviderId;
  if (providerId) {
    // Tenant-scoped read: another company's provider id is simply not found.
    const provider = await prisma.shippingProvider.findFirst({ where: { id: providerId, isActive: true }, select: { id: true } });
    if (!provider) return actionError("Transporteur introuvable ou inactif.");
  }

  const previous = await prisma.businessSettings.findUnique({ where: { tenantId: user.tenantId }, select: { defaultShippingProviderId: true } });
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: { defaultShippingProviderId: providerId },
    create: { defaultShippingProviderId: providerId },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    previousValue: { defaultShippingProviderId: previous?.defaultShippingProviderId ?? null },
    newValue: { defaultShippingProviderId: settings.defaultShippingProviderId },
  });
  revalidatePath("/parametres");
  return actionOk(settings);
}
