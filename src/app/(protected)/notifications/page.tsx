import { Bell } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { DismissNotificationButton } from "@/components/notifications/dismiss-notification-button";
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
        actions={unreadCount > 0 ? <MarkAllReadButton /> : undefined}
      />

      {notifications.length === 0 ? (
        <EmptyState icon={Bell} title="Aucune notification pour le moment." />
      ) : (
        <div className="divide-y rounded-lg border">
          {notifications.map((n) => (
            <div key={n.id} className={`flex items-start justify-between gap-4 p-4 ${n.isRead ? "" : "bg-muted/40"}`}>
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="outline">{NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}</Badge>
                  {!n.isRead && <Badge variant="default">Non lu</Badge>}
                </div>
                <p className="text-sm font-medium">{n.title}</p>
                <p className="text-sm text-muted-foreground">{n.message}</p>
              </div>
              <div className="flex shrink-0 items-start gap-2">
                <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                <DismissNotificationButton id={n.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
