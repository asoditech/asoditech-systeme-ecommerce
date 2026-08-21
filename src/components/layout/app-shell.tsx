import { SidebarNav } from "@/components/layout/sidebar-nav";
import { LogoutButton } from "@/components/layout/logout-button";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { BrandMark } from "@/components/brand-mark";
import { getRecentNotifications } from "@/lib/queries/notifications";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { CurrentUser } from "@/lib/auth/session";

export async function AppShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  const permissions = new Set(ROLE_PERMISSIONS[user.role]);
  const { items, unreadCount } = await getRecentNotifications(user.id);

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-14 items-center border-b px-4">
          <BrandMark />
        </div>
        <div className="flex-1 overflow-y-auto">
          <SidebarNav permissions={permissions} />
        </div>
        <div className="border-t p-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{USER_ROLE_LABELS[user.role]}</p>
            </div>
            <LogoutButton />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:px-6">
          <div className="flex items-center gap-2 md:hidden">
            <BrandMark />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <CommandPalette permissions={permissions} />
            <NotificationBell items={items} unreadCount={unreadCount} />
          </div>
        </header>
        <div className="border-b md:hidden">
          <SidebarNav orientation="horizontal" permissions={permissions} />
        </div>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
