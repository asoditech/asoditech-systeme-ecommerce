import "server-only";

import { cache } from "react";
import { prisma, prismaBase } from "@/lib/prisma";
import { shellLogoSrc } from "@/lib/branding/shell-logo";

export interface ShellLogo {
  src: string;
  companyName: string;
}

/**
 * The current company's logo for the app shell, or null (ASODITECH mark).
 * The grant is read for THIS user's tenant only (the platform flag lives on
 * Tenant, outside RLS-scoped business tables); the image comes from this
 * tenant's own BusinessSettings through the tenant-scoped client — never
 * another company's.
 */
export const getShellLogo = cache(async function getShellLogo(tenantId: string): Promise<ShellLogo | null> {
  const tenant = await prismaBase.tenant.findUnique({ where: { id: tenantId }, select: { brandLogoGranted: true } });
  if (!tenant?.brandLogoGranted) return null;
  const settings = await prisma.businessSettings.findFirst({ select: { logoUrl: true, companyName: true } });
  const src = shellLogoSrc(true, settings?.logoUrl);
  return src ? { src, companyName: settings?.companyName ?? "" } : null;
});
