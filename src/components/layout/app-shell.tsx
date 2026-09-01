import { SidebarNav } from "@/components/layout/sidebar-nav";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { BrandMark } from "@/components/brand-mark";
import { getRecentNotifications } from "@/lib/queries/notifications";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { CurrentUser } from "@/lib/auth/session";

export async function AppShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  const permissions = new Set(ROLE_PERMISSIONS[user.role]);
  const { items, unreadCount } = await getRecentNotifications(user.id);

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
          <BrandMark />
        </div>
        <div className="sidebar-scroll flex-1 overflow-y-auto">
          <SidebarNav permissions={permissions} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col md:pl-64">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-backdrop-filter:bg-background/80 md:px-6">
          <MobileNav permissions={permissions} />
          <div className="md:hidden">
            <BrandMark />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <CommandPalette permissions={permissions} />
            <ThemeToggle />
            <NotificationBell items={items} unreadCount={unreadCount} />
            <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <UserMenu name={user.name} role={USER_ROLE_LABELS[user.role]} />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable] md:p-6">
          <div className="mx-auto w-full max-w-[1600px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
