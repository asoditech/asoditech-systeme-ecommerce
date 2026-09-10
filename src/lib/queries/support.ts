import "server-only";

import { prisma } from "@/lib/prisma";

export interface SupportConfig {
  name: string | null;
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  hours: string | null;
  companyName: string;
}

/**
 * The support-contact configuration for the current tenant, read from
 * `BusinessSettings`. Everything is nullable — an unset field simply hides
 * that contact action in the widget. `companyName` comes along for the
 * pre-filled WhatsApp / report message.
 */
export async function getSupportConfig(): Promise<SupportConfig> {
  const settings = await prisma.businessSettings.findFirst({
    select: {
      companyName: true,
      supportName: true,
      supportWhatsapp: true,
      supportPhone: true,
      supportEmail: true,
      supportHours: true,
    },
  });

  return {
    name: settings?.supportName ?? null,
    whatsapp: settings?.supportWhatsapp ?? null,
    phone: settings?.supportPhone ?? null,
    email: settings?.supportEmail ?? null,
    hours: settings?.supportHours ?? null,
    companyName: settings?.companyName?.trim() || "ASODITECH",
  };
}
