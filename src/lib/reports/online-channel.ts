import "server-only";

import type { Prisma } from "@prisma/client";
import { listAccessibleChannels } from "@/lib/auth/channel-access";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * « Canal en ligne » filter for the Online /rapports pages (`?canal=<id>`).
 *
 * The id is honoured only when it is one of the viewer's OWN active ONLINE
 * channels (tenant-scoped client + channel scope): an unknown, foreign or
 * other-tenant id is ignored — the report then shows exactly what it showed
 * without the param, never another tenant's data. A valid channel with no
 * orders gives genuine zeros: the filter is an AND on the query, never a
 * fallback to "all".
 */
export async function resolveReportOnlineChannel(viewer: Pick<CurrentUser, "channels">, canal: string | undefined) {
  const channels = await listAccessibleChannels(viewer, "ONLINE");
  const salesChannelId = canal && channels.some((c) => c.id === canal) ? canal : undefined;
  return { channels: channels.map((c) => ({ id: c.id, name: c.name })), salesChannelId };
}

/** The order-level `where` a report ANDs into its own query. */
export function reportOrderScope(salesChannelId: string | undefined): Prisma.OrderWhereInput {
  return salesChannelId ? { salesChannelId } : {};
}
