import "server-only";

import { prismaBase } from "@/lib/prisma";
import type { BusinessMode } from "@/lib/tenant/business-mode";

/**
 * Changing a tenant's business mode — docs/adr/0041-tenant-business-mode.md.
 * Platform-admin only (the callers are `requirePlatformAdminForAction`-gated);
 * unscoped (`prismaBase`) because it runs across tenants, like the rest of
 * `/platform`.
 *
 *  - UPGRADE (ONLINE_ONLY → ONLINE_AND_OFFLINE) is always allowed: it only
 *    unlocks capabilities. Nothing is created for the tenant except making sure
 *    its default Online channel exists (self-healing, idempotent).
 *  - DOWNGRADE is REFUSED while the tenant owns Offline BUSINESS DOCUMENTS
 *    (sales, sale returns, purchase receptions, supplier payments). Hiding them
 *    would strand real financial/stock history that nobody could then read, fix
 *    or trace — and a tenant's mode is never allowed to make its own records
 *    invisible. A tenant with only configuration (store channels, suppliers with
 *    no documents, barcodes) can be downgraded: that data is kept, just inert,
 *    and comes back if the tenant is promoted again. Nothing is ever deleted.
 */

export interface OfflineFootprint {
  sales: number;
  saleReturns: number;
  receptions: number;
  supplierPayments: number;
  /** Informational only — configuration, never blocks a downgrade. */
  storeChannels: number;
  suppliers: number;
  barcodes: number;
  /** Total of the four BLOCKING counts. */
  documents: number;
}

export async function getOfflineFootprint(tenantId: string): Promise<OfflineFootprint> {
  const [sales, saleReturns, receptions, supplierPayments, storeChannels, suppliers, barcodes] = await Promise.all([
    prismaBase.sale.count({ where: { tenantId } }),
    prismaBase.saleReturn.count({ where: { tenantId } }),
    prismaBase.reception.count({ where: { tenantId } }),
    prismaBase.supplierPayment.count({ where: { tenantId } }),
    prismaBase.salesChannel.count({ where: { tenantId, kind: "OFFLINE" } }),
    prismaBase.supplier.count({ where: { tenantId } }),
    prismaBase.barcode.count({ where: { tenantId } }),
  ]);
  return {
    sales,
    saleReturns,
    receptions,
    supplierPayments,
    storeChannels,
    suppliers,
    barcodes,
    documents: sales + saleReturns + receptions + supplierPayments,
  };
}

export interface ModeChangePlan {
  from: BusinessMode;
  to: BusinessMode;
  allowed: boolean;
  /** French, user-facing — why it is refused (only when `allowed` is false). */
  reason: string | null;
  footprint: OfflineFootprint;
}

export async function planBusinessModeChange(tenantId: string, to: BusinessMode): Promise<ModeChangePlan | null> {
  const tenant = await prismaBase.tenant.findUnique({ where: { id: tenantId }, select: { businessMode: true } });
  if (!tenant) return null;
  const footprint = await getOfflineFootprint(tenantId);
  const from = tenant.businessMode;

  if (from === to) {
    return { from, to, allowed: false, reason: "Le tenant est déjà dans ce mode.", footprint };
  }
  if (to === "ONLINE_ONLY" && footprint.documents > 0) {
    const parts = [
      footprint.sales > 0 ? `${footprint.sales} vente(s) magasin` : null,
      footprint.saleReturns > 0 ? `${footprint.saleReturns} retour(s) de vente` : null,
      footprint.receptions > 0 ? `${footprint.receptions} réception(s)` : null,
      footprint.supplierPayments > 0 ? `${footprint.supplierPayments} paiement(s) fournisseur` : null,
    ].filter(Boolean);
    return {
      from,
      to,
      allowed: false,
      reason: `Impossible de repasser en « En ligne seul » : ce tenant possède ${parts.join(", ")}. Ces documents ne seraient plus consultables.`,
      footprint,
    };
  }
  return { from, to, allowed: true, reason: null, footprint };
}
