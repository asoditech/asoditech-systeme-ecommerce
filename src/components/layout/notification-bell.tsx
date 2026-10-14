"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DismissNotificationButton } from "@/components/notifications/dismiss-notification-button";
import { formatDateTime } from "@/lib/format";
import { NOTIFICATION_TYPE_LABELS } from "@/lib/status-labels";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/actions/notifications";
import type { Notification } from "@prisma/client";

export function NotificationBell({
  items,
  unreadCount,
}: {
  items: Notification[];
  unreadCount: number;
}) {
  const router = useRouter();

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon" className="relative size-10 rounded-full border border-hairline bg-shell text-ink-secondary shadow-soft hover:bg-nav-hover hover:text-ink sm:size-11" aria-label="Notifications" />
        }
      >
        <Bell className="size-4" />
        {unreadCount > 0 && (
          <Badge
            variant="destructive"
            className="absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-shell bg-danger px-1 text-[10px] leading-none text-white tabular-nums"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(20rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b p-3">
          <p className="text-sm font-medium">Notifications</p>
          {unreadCount > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={async () => {
                await markAllNotificationsReadAction();
                router.refresh();
              }}
            >
              Tout marquer comme lu
            </button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">Aucune notification.</p>
          ) : (
            items.map((n) => (
              <div key={n.id} className="group relative border-b last:border-b-0">
                <button
                  type="button"
                  onClick={async () => {
                    if (!n.isRead) {
                      await markNotificationReadAction(n.id);
                      router.refresh();
                    }
                  }}
                  className="flex w-full flex-col gap-0.5 px-3 py-2.5 pr-8 text-left hover:bg-muted"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}
                    </span>
                    {!n.isRead && <Badge variant="default" className="h-1.5 w-1.5 rounded-full p-0" />}
                  </div>
                  <p className="text-sm font-medium">{n.title}</p>
                  <p className="text-xs text-muted-foreground">{n.message}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">{formatDateTime(n.createdAt)}</p>
                </button>
                <DismissNotificationButton
                  id={n.id}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100"
                />
              </div>
            ))
          )}
        </div>
        <div className="border-t p-2">
          <Link
            href="/notifications"
            className="block rounded-lg px-2 py-1.5 text-center text-xs text-ink-secondary transition-colors hover:bg-row-hover hover:text-ink"
          >
            Voir toutes les notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
