import Link from "next/link";
import { cookies } from "next/headers";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { IntegrationsFooter } from "@/components/layout/integrations-footer";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { NotificationSoundListener } from "@/components/layout/notification-sound-listener";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { BrandMark } from "@/components/brand-mark";
import { SupportWidget } from "@/components/support/support-widget";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { getRecentNotifications } from "@/lib/queries/notifications";
import { getSupportConfig } from "@/lib/queries/support";
import { getActiveAnnouncement } from "@/lib/queries/announcements";
import { ANNOUNCEMENT_DISMISS_COOKIE, parseDismissedCookie } from "@/lib/announcements";
import { aiQuestionsForUser } from "@/lib/ai/tools";
import { userHasPermission } from "@/lib/auth/permissions";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { CurrentUser } from "@/lib/auth/session";

export async function AppShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  // Effective permissions (role + per-user overrides, filtered by channel
  // scope — docs/adr/0039), so the sidebar shows exactly what the server
  // will actually allow.
  const permissions = new Set(user.permissions);
  const cookieStore = await cookies();
  const [{ items, unreadCount }, supportConfig, announcement] = await Promise.all([
    getRecentNotifications(user.id),
    getSupportConfig(),
    // Platform announcement (docs/adr/0059): the one live announcement this
    // browser hasn't dismissed — null renders nothing at all.
    getActiveAnnouncement(parseDismissedCookie(cookieStore.get(ANNOUNCEMENT_DISMISS_COOKIE)?.value)),
  ]);
  const canUseAi = userHasPermission(user, "ai.use");
  // Server-read so the very first paint already reflects the viewer's
  // saved sidebar-collapse preference — no client-only effect, no flash.
  const sidebarCollapsed = cookieStore.get("sidebar-collapsed")?.value === "1";

  return (
    <SidebarShell permissions={permissions} defaultCollapsed={sidebarCollapsed}>
      {/* Top announcement bar — first in the content column, above the sticky header, in normal flow (scrolls away; the header stays sticky; the fixed sidebar is untouched).
          Keyed by id + last edit: a different (or edited) announcement remounts the bar, so a previous dismissal's local state never hides it. */}
      {announcement && <AnnouncementBar key={announcement.key} announcement={announcement} />}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-backdrop-filter:bg-background/80 md:px-6">
        <MobileNav permissions={permissions} />
        <div className="md:hidden">
          <Link href="/tableau-de-bord">
            <BrandMark />
          </Link>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <CommandPalette permissions={permissions} />
          <ThemeToggle />
          <NotificationSoundListener />
          <NotificationBell items={items} unreadCount={unreadCount} />
          <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <UserMenu name={user.name} role={USER_ROLE_LABELS[user.role]} />
        </div>
      </header>
      {/* pb clears the fixed IntegrationsFooter (h-9) so nothing hides behind it */}
      <main className="flex-1 overflow-y-auto p-4 pb-14 [scrollbar-gutter:stable] md:p-6 md:pb-16">
        <div className="mx-auto w-full max-w-[1600px]">{children}</div>
      </main>
      <IntegrationsFooter />

      <SupportWidget
        canUseAi={canUseAi}
        questions={canUseAi ? aiQuestionsForUser(user) : []}
        config={supportConfig}
      />
    </SidebarShell>
  );
}
