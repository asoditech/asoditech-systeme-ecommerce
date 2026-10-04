import "server-only";

import { prismaBase } from "@/lib/prisma";
import { announcementDismissKey, pickAnnouncement, safeAnnouncementUrl, type AnnouncementTypeValue } from "@/lib/announcements";

/**
 * Platform announcements (docs/adr/0059). `PlatformAnnouncement` is a GLOBAL
 * table (no tenantId — same as `Plan`), read through the base client.
 */

/** What the bar receives — only display fields, never author ids. */
export interface ActiveAnnouncement {
  id: string;
  /** Dismissal key (id + last edit time). */
  key: string;
  message: string;
  type: AnnouncementTypeValue;
  actionLabel: string | null;
  actionUrl: string | null;
}

/**
 * The single announcement to show in the app shell for this browser, or null.
 * Fail-soft: the bar is a convenience, so a read error (e.g. this release's
 * migration not applied yet) renders no bar instead of breaking every page.
 */
export async function getActiveAnnouncement(dismissed: ReadonlySet<string>, now: Date = new Date()): Promise<ActiveAnnouncement | null> {
  let rows;
  try {
    rows = await prismaBase.platformAnnouncement.findMany({
      where: {
        isPublished: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  } catch (error) {
    console.error("[announcements] could not load the active announcement", error);
    return null;
  }
  const picked = pickAnnouncement(rows, now, dismissed);
  if (!picked) return null;
  const actionUrl = safeAnnouncementUrl(picked.actionUrl);
  return {
    id: picked.id,
    key: announcementDismissKey(picked),
    message: picked.message,
    type: picked.type,
    // Re-checked at render time too: a link is shown only with BOTH parts valid.
    actionLabel: actionUrl ? picked.actionLabel : null,
    actionUrl: picked.actionLabel ? actionUrl : null,
  };
}

/** `/platform/annonces` list — newest first. Callers must already be platform-admin gated. */
export async function listPlatformAnnouncements() {
  return prismaBase.platformAnnouncement.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
}
