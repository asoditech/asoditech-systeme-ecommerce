import "server-only";

import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { DEFAULT_BUSINESS_TIME_ZONE, isValidTimeZone } from "@/lib/time/zoned";

/**
 * The current tenant's business time zone (BusinessSettings.timezone — the
 * « Fuseau horaire » setting, « Africa/Casablanca » by default), used for
 * every « aujourd'hui / hier / ce mois » boundary and every day filter.
 * Tenant-scoped through the extended `prisma` client; an unset or invalid
 * value falls back to the setting's own default. Memoised per request.
 */
export const getBusinessTimeZone = cache(async (): Promise<string> => {
  const s = await prisma.businessSettings.findFirst({ select: { timezone: true } });
  return isValidTimeZone(s?.timezone) ? s.timezone : DEFAULT_BUSINESS_TIME_ZONE;
});
