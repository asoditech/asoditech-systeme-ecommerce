import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Which customers a user may see — derived from existing activity, no extra
 * table. Applied by every customer read: Clients list/detail/stats, the
 * order form's customer search, the command palette and the dashboard count.
 *
 *   OWNER / ADMIN / MANAGER, a global channel scope, or an ONLINE_ONLY tenant
 *   (no channel scope exists there) → every customer.
 *   Everyone else → customers with an order on one of their ONLINE channels
 *     (an order without a channel counts as online), or a sale on one of
 *     their OFFLINE channels, plus customers with no order and no sale yet.
 *
 * Who may open the Clients page at all is still the `customers.*`
 * permission (store roles have none) — this only narrows the rows.
 */
export function customerVisibilityWhere(
  user: Pick<CurrentUser, "role" | "channels" | "businessMode">
): Prisma.CustomerWhereInput {
  if (user.channels.global || user.businessMode !== "ONLINE_AND_OFFLINE") return {};
  if (user.role === "OWNER" || user.role === "ADMIN" || user.role === "MANAGER") return {};
  const online = [...user.channels.onlineIds];
  const offline = [...user.channels.offlineIds];
  const or: Prisma.CustomerWhereInput[] = [{ orders: { none: {} }, sales: { none: {} } }];
  if (user.channels.online) {
    or.push({ orders: { some: { OR: [{ salesChannelId: { in: online } }, { salesChannelId: null }] } } });
  }
  if (offline.length > 0) or.push({ sales: { some: { salesChannelId: { in: offline } } } });
  return { OR: or };
}
