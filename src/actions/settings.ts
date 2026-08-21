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
    address: formData.get("address"),
    city: formData.get("city"),
    country: formData.get("country") || "Maroc",
    phone: formData.get("phone"),
    email: formData.get("email"),
    timezone: formData.get("timezone") || "Africa/Casablanca",
    lowStockDefaultThreshold: formData.get("lowStockDefaultThreshold") || 5,
    orderNumberPrefix: formData.get("orderNumberPrefix") || "CMD",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const settings = await prisma.businessSettings.upsert({
    where: { id: "singleton" },
    update: {
      companyName: parsed.data.companyName,
      currency: parsed.data.currency,
      address: normalizeOptional(parsed.data.address),
      city: normalizeOptional(parsed.data.city),
      country: parsed.data.country,
      phone: normalizeOptional(parsed.data.phone),
      email: normalizeOptional(parsed.data.email),
      timezone: parsed.data.timezone,
      lowStockDefaultThreshold: parsed.data.lowStockDefaultThreshold,
      orderNumberPrefix: parsed.data.orderNumberPrefix,
    },
    create: { id: "singleton", ...parsed.data },
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
