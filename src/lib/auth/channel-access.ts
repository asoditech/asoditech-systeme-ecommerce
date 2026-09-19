import "server-only";

import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/auth/session";
import type { ChannelDomain } from "@/lib/auth/permissions";

/**
 * Channel scope — READ and WRITE authorization by business activity
 * (docs/adr/0039-permission-overrides-and-scope.md). The channel counterpart
 * of location-access.ts, with the one big difference the requirements demand:
 * it scopes READS, not just mutations.
 *
 * How the read scope is enforced (defence in depth, three layers):
 *   1. Effective permissions are filtered by channel scope when the session
 *      is resolved (effective-access.ts) — an Online-only user holds no
 *      OFFLINE-domain permission and vice versa, so every page / Server
 *      Action / AI tool / notification list already gated on a permission is
 *      scoped for free.
 *   2. Every OFFLINE-domain query (sales, returns, receptions' channel-bound
 *      data) is ROW-scoped here by `salesChannelId` — a user assigned to one
 *      store never sees another store's sales, even with `sales.view`.
 *   3. The few SHARED surfaces that mix both activities (dashboard, reports,
 *      search, audit, stock history, product stats) consult `canReadKind`
 *      and drop / block the part they aren't entitled to.
 *
 * Never a UI concern: nothing here (or in the callers) relies on hiding a
 * menu item.
 */

type Db = typeof prisma | PrismaTransactionClient;
type ScopeUser = Pick<CurrentUser, "channels">;

/** May this user read/act on ANY channel of this activity? */
export function canReadKind(user: ScopeUser, kind: ChannelDomain): boolean {
  return kind === "ONLINE" ? user.channels.online : user.channels.offline;
}

/** Page-level guard: redirects to /acces-refuse (the user IS authenticated — they just may not see this). */
export function requireChannelKind(user: ScopeUser, kind: ChannelDomain): void {
  if (!canReadKind(user, kind)) redirect("/acces-refuse");
}

/** Server-Action guard: throws, like `requirePermissionForAction`. */
export function requireChannelKindForAction(user: ScopeUser, kind: ChannelDomain): void {
  if (!canReadKind(user, kind)) {
    throw new Error("Non autorisé : accès au canal requis pour cette action.");
  }
}

/**
 * Prisma `where` restricting a `Sale` query to the OFFLINE channels the user
 * may read. OWNER/ADMIN → no restriction. Everyone else → exactly their
 * assigned OFFLINE channels; none assigned → matches nothing (default-deny,
 * never "all").
 */
export function saleChannelWhere(user: ScopeUser): { salesChannelId?: { in: string[] } } {
  if (user.channels.global) return {};
  return { salesChannelId: { in: [...user.channels.offlineIds] } };
}

/** Same restriction for any model carrying `salesChannelId` (Order → ONLINE ids). */
export function orderChannelWhere(user: ScopeUser): Prisma.OrderWhereInput {
  if (user.channels.global) return {};
  return { salesChannelId: { in: [...user.channels.onlineIds] } };
}

/** Whether the user may act on / read ONE specific channel id. */
export function canAccessChannel(user: ScopeUser, salesChannelId: string): boolean {
  if (user.channels.global) return true;
  return user.channels.ids.includes(salesChannelId);
}

/**
 * The Server-Action boundary for a channel-bound mutation: resolves the
 * channel through the tenant-scoped client (a forged / foreign id is simply
 * not found), requires it to be active, and requires the acting user's scope
 * to include it. Returns the channel.
 */
export async function requireChannelAccessForAction(
  user: ScopeUser,
  salesChannelId: string,
  opts: { kind?: ChannelDomain; db?: Db } = {}
) {
  const db = opts.db ?? prisma;
  const channel = await db.salesChannel.findUnique({ where: { id: salesChannelId } });
  if (!channel) throw new Error("Canal de vente introuvable.");
  if (!channel.isActive) throw new Error("Ce canal de vente est inactif.");
  if (opts.kind && channel.kind !== opts.kind) throw new Error("Type de canal invalide pour cette opération.");
  if (!canAccessChannel(user, channel.id)) {
    throw new Error("Non autorisé : ce canal ne vous est pas attribué.");
  }
  return channel;
}

/** Active channels the user may use, optionally of one activity — feeds every channel picker. */
export async function listAccessibleChannels(user: ScopeUser, kind?: ChannelDomain, db: Db = prisma) {
  return db.salesChannel.findMany({
    where: {
      isActive: true,
      ...(kind ? { kind } : {}),
      ...(user.channels.global ? {} : { id: { in: [...user.channels.ids] } }),
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true, isDefault: true },
  });
}
