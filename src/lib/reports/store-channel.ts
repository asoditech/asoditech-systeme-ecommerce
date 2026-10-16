import "server-only";

import { listAccessibleChannels } from "@/lib/auth/channel-access";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * « Magasin » filter for the store parts of /rapports and the dashboard
 * (`?magasin=<id>`, same parameter as /analyses). Twin of
 * `resolveReportOnlineChannel`: the id is honoured only when it is one of the
 * viewer's OWN OFFLINE channels (tenant-scoped client + channel scope) — an
 * unknown, ONLINE, foreign or other-tenant id is ignored and the report keeps
 * « Tous les magasins » (the viewer's), never another tenant's data. The
 * queries still AND it onto `saleChannelWhere`, so it can only narrow.
 */
export async function resolveReportStoreChannel(viewer: Pick<CurrentUser, "channels">, magasin: string | undefined) {
  const channels = viewer.channels.offline ? await listAccessibleChannels(viewer, "OFFLINE") : [];
  const salesChannelId = magasin && channels.some((c) => c.id === magasin) ? magasin : undefined;
  const name = salesChannelId ? channels.find((c) => c.id === salesChannelId)?.name : undefined;
  return { channels: channels.map((c) => ({ id: c.id, name: c.name })), salesChannelId, label: name ? `Magasin : ${name}` : "Tous les magasins" };
}
