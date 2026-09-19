import type { Prisma } from "@prisma/client";
import type { ChannelAccess } from "@/lib/auth/effective-access";

/**
 * Inventory-movement read scope — docs/adr/0039.
 *
 * The ledger is SHARED (one physical stock), but a movement can carry the
 * fingerprint of ONE activity: an order (Online) or a sale (Offline). Showing
 * "VENTE — VTE-000123 — 3 × Basket" to a user with no Offline channel would
 * leak an Offline transaction through the stock history, so a history read is
 * restricted to what the viewer's channels entitle them to:
 *
 *   - no ONLINE channel  → drop movements tied to an order / order return;
 *   - no OFFLINE channel → drop movements tied to a sale / sale return;
 *   - some OFFLINE channels → keep only movements of sales of THOSE channels;
 *   - movements tied to NO document (receptions, transfers, stocktakes,
 *     adjustments, legacy rows) are shared and always visible.
 *
 * Known limit (docs/adr/0039): location visibility itself is not read-scoped,
 * so a location shared by both channels still shows the shared movements.
 */
export function movementScopeWhere(
  channels: Pick<ChannelAccess, "global" | "online" | "offline" | "offlineIds">
): Prisma.InventoryMovementWhereInput {
  if (channels.global || (channels.online && channels.offline && channels.offlineIds.length === 0)) return {};
  const and: Prisma.InventoryMovementWhereInput[] = [];
  if (!channels.online) and.push({ orderId: null, orderReturnId: null });
  if (!channels.offline) {
    and.push({ saleId: null, saleReturnId: null });
  } else {
    and.push({ OR: [{ saleId: null }, { sale: { salesChannelId: { in: [...channels.offlineIds] } } }] });
  }
  return and.length > 0 ? { AND: and } : {};
}
