import Link from "next/link";
import { Bell, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { DismissNotificationButton } from "@/components/notifications/dismiss-notification-button";
import { SoundToggle } from "@/components/notifications/sound-toggle";
import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Notifications — ASODITECH Gestion E-commerce" };

export default async function NotificationsPage() {
  const user = await requireUser();
  const notifications = await prisma.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Alertes de stock, commandes, livraisons et intégrations vous concernant."
        actions={
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <SoundToggle />
            {unreadCount > 0 && <MarkAllReadButton />}
            <Button size="sm" variant="outline" render={<Link href="/parametres/notifications" />}>
              <Settings2 className="size-3.5" />
              Préférences
            </Button>
          </div>
        }
      />

      {notifications.length === 0 ? (
        <EmptyState icon={Bell} title="Aucune notification pour le moment." />
      ) : (
        <div className="divide-y divide-hairline overflow-hidden rounded-card bg-card shadow-card">
          {notifications.map((n) => (
            <div key={n.id} className={`flex items-start justify-between gap-3 px-4 py-4 sm:px-6 ${n.isRead ? "" : "bg-pill-peach/25"}`}>
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}</Badge>
                  {!n.isRead && <Badge variant="default">Non lu</Badge>}
                </div>
                <p className="text-sm font-semibold text-ink">{n.title}</p>
                <p className="text-sm text-ink-secondary">{n.message}</p>
              </div>
              <div className="flex shrink-0 flex-col-reverse items-end gap-1 sm:flex-row sm:items-start sm:gap-2">
                <span className="text-xs whitespace-nowrap text-ink-muted">{formatDateTime(n.createdAt)}</span>
                <DismissNotificationButton id={n.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
