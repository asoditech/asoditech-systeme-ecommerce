import "server-only";

import { prisma } from "@/lib/prisma";

export interface ReportBusinessInfo {
  companyName: string;
  logoUrl: string | null;
  address: string | null;
  city: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  currency: string;
}

/** The tenant's business identity for printed report letterheads and
 * delivery invoices — company name, logo, address, contact. Falls back to
 * safe defaults when the tenant hasn't filled in its settings yet, so
 * callers never have to null-check. */
export async function getReportBusinessInfo(): Promise<ReportBusinessInfo> {
  const s = await prisma.businessSettings.findFirst();
  return {
    companyName: s?.companyName?.trim() || "ASODITECH",
    logoUrl: s?.logoUrl ?? null,
    address: s?.address ?? null,
    city: s?.city ?? null,
    country: s?.country ?? "Maroc",
    phone: s?.phone ?? null,
    email: s?.email ?? null,
    currency: s?.currency ?? "MAD",
  };
}
