"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { updateBusinessSettingsSchema } from "@/lib/validation/settings";
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
