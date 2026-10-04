import { PageHeader } from "@/components/page-header";
import { AnnouncementManager } from "@/components/platform/announcement-manager";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { listPlatformAnnouncements } from "@/lib/queries/announcements";

export const metadata = { title: "Annonces — ASODITECH Gestion E-commerce" };

/**
 * `/platform/annonces` — platform-wide announcement bar management
 * (docs/adr/0059). The platform layout already gates this area; the page
 * re-checks so it never depends on layout behaviour alone.
 */
export default async function PlatformAnnouncementsPage() {
  await requirePlatformAdmin();
  const announcements = await listPlatformAnnouncements();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Annonces"
        description="Message affiché sous l'en-tête de tous les espaces clients : information, maintenance ou nouveauté. Une seule annonce est visible à la fois (maintenance d'abord, puis la plus récente)."
      />
      <AnnouncementManager
        announcements={announcements.map((a) => ({
          id: a.id,
          message: a.message,
          type: a.type,
          isPublished: a.isPublished,
          startsAt: a.startsAt?.toISOString() ?? null,
          endsAt: a.endsAt?.toISOString() ?? null,
          actionLabel: a.actionLabel,
          actionUrl: a.actionUrl,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        }))}
      />
    </div>
  );
}
