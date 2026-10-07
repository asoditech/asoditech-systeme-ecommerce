import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";

/** « Vérification de l'emballage obligatoire » for the active tenant (default off). */
export async function isPackingRequired(db: typeof prisma | PrismaTransactionClient = prisma): Promise<boolean> {
  const settings = await db.businessSettings.findFirst({ select: { packingVerificationRequired: true } });
  return settings?.packingVerificationRequired ?? false;
}
