"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/audit";
import {
  updateBusinessSettingsSchema,
  updateCostingMethodSchema,
  updateDefaultShippingProviderSchema,
  updateSellerPriceOverrideSchema,
  updatePackingVerificationSchema,
  updateTransferCostOverrideSchema,
} from "@/lib/validation/settings";
import { requireCapabilityForAction } from "@/lib/auth/capabilities";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { BusinessSettings } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

/** Every field `updateBusinessSettingsAction` manages (one schema, see updateBusinessSettingsSchema). */
const BUSINESS_SETTINGS_FIELDS = [
  "companyName",
  "currency",
  "logoUrl",
  "address",
  "city",
  "country",
  "phone",
  "email",
  "timezone",
  "lowStockDefaultThreshold",
  "orderNumberPrefix",
  "supportName",
  "supportWhatsapp",
  "supportPhone",
  "supportEmail",
  "supportHours",
] as const;

/**
 * Company-wide settings (Paramètres → Configuration). Each section saves
 * only ITS fields: a field absent from the submitted form keeps its stored
 * value (so saving « Support » never resets the company name), a field
 * present but empty is cleared. The merged result is validated by the one
 * shared schema, exactly as before.
 */
export async function updateBusinessSettingsAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");

  const current = await prisma.businessSettings.findUnique({ where: { tenantId: user.tenantId } });
  const submitted = BUSINESS_SETTINGS_FIELDS.filter((f) => formData.has(f));
  const value = (field: (typeof BUSINESS_SETTINGS_FIELDS)[number]) =>
    formData.has(field) ? formData.get(field) : (current?.[field] ?? undefined);

  const threshold = value("lowStockDefaultThreshold");
  const parsed = updateBusinessSettingsSchema.safeParse({
    companyName: value("companyName") || "",
    currency: value("currency") || "MAD",
    logoUrl: value("logoUrl"),
    address: value("address"),
    city: value("city"),
    country: value("country") || "Maroc",
    phone: value("phone"),
    email: value("email"),
    timezone: value("timezone") || "Africa/Casablanca",
    lowStockDefaultThreshold: threshold === "" || threshold == null ? 5 : threshold, // a stored 0 stays 0
    orderNumberPrefix: value("orderNumberPrefix") || "CMD",
    supportName: value("supportName"),
    supportWhatsapp: value("supportWhatsapp"),
    supportPhone: value("supportPhone"),
    supportEmail: value("supportEmail"),
    supportHours: value("supportHours"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // Phase 3 (docs/adr/0025): BusinessSettings is tenant-scoped, not a
  // global singleton — looked up/created by `tenantId`, never the old
  // fixed `id: "singleton"` (which now belongs only to the bootstrap
  // tenant's original row).
  const data = {
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
  };
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: data,
    create: data,
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    newValue: { companyName: settings.companyName },
    metadata: { fields: submitted },
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
 * « Vérification de l'emballage obligatoire » — tenant-wide, default off.
 * When on, an online order is shippable only once its packing was verified
 * (Order.packedAt): « À expédier » and every shipment-creation action enforce
 * it on the server (src/lib/packing.ts). Off = today's behaviour.
 */
export async function updatePackingVerificationAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");
  const parsed = updatePackingVerificationSchema.safeParse({ packingVerificationRequired: formData.get("packingVerificationRequired") });
  if (!parsed.success) return actionError("Valeur invalide.", parsed.error.flatten().fieldErrors);

  const previous = await prisma.businessSettings.findUnique({ where: { tenantId: user.tenantId }, select: { packingVerificationRequired: true } });
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: { packingVerificationRequired: parsed.data.packingVerificationRequired },
    create: { packingVerificationRequired: parsed.data.packingVerificationRequired },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    previousValue: { packingVerificationRequired: previous?.packingVerificationRequired ?? false },
    newValue: { packingVerificationRequired: settings.packingVerificationRequired },
  });
  revalidatePath("/parametres");
  revalidatePath("/livraison");
  return actionOk(settings);
}

/**
 * « Coût d'achat à destination » sur les transferts — tenant-wide, default off.
 * When on, a transfer line may carry a destination PURCHASE cost (never a
 * selling price), copied to the TRANSFERT_ENTREE movement on receive
 * (src/lib/transfers.ts). Turning it off blocks entering new costs; costs
 * already recorded on transfer lines stay as history. Off = today's behaviour.
 */
export async function updateTransferCostOverrideAction(formData: FormData): Promise<ActionResult<BusinessSettings>> {
  const user = await requirePermissionForAction("settings.manage");
  // A purchase-cost setting is financial data too (docs/adr/0043).
  if (!userHasPermission(user, "finance.view")) {
    return actionError("Ce réglage est réservé aux utilisateurs ayant accès aux données financières.");
  }
  const parsed = updateTransferCostOverrideSchema.safeParse({
    transferPurchaseCostOverrideEnabled: formData.get("transferPurchaseCostOverrideEnabled"),
  });
  if (!parsed.success) return actionError("Valeur invalide.", parsed.error.flatten().fieldErrors);

  const previous = await prisma.businessSettings.findUnique({
    where: { tenantId: user.tenantId },
    select: { transferPurchaseCostOverrideEnabled: true },
  });
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: { transferPurchaseCostOverrideEnabled: parsed.data.transferPurchaseCostOverrideEnabled },
    create: { transferPurchaseCostOverrideEnabled: parsed.data.transferPurchaseCostOverrideEnabled },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "settings.updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    previousValue: { transferPurchaseCostOverrideEnabled: previous?.transferPurchaseCostOverrideEnabled ?? false },
    newValue: { transferPurchaseCostOverrideEnabled: settings.transferPurchaseCostOverrideEnabled },
  });
  revalidatePath("/parametres");
  revalidatePath("/transferts");
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
