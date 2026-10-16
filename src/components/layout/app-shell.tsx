import Link from "next/link";
import { cookies } from "next/headers";
import { Plus } from "lucide-react";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { IntegrationsFooter } from "@/components/layout/integrations-footer";
import { MobileNav } from "@/components/layout/mobile-nav";
import { CommandPalette } from "@/components/layout/command-palette";
import { NotificationBell } from "@/components/layout/notification-bell";
import { NotificationSoundListener } from "@/components/layout/notification-sound-listener";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { BrandMark } from "@/components/brand-mark";
import { CompanyLogo } from "@/components/layout/company-logo";
import { getShellLogo } from "@/lib/queries/branding";
import { SupportWidget } from "@/components/support/support-widget";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { getRecentNotifications } from "@/lib/queries/notifications";
import { getSupportConfig } from "@/lib/queries/support";
import { getActiveAnnouncement } from "@/lib/queries/announcements";
import { ANNOUNCEMENT_DISMISS_COOKIE, parseDismissedCookie } from "@/lib/announcements";
import { aiQuestionsForUser } from "@/lib/ai/tools";
import { userHasPermission } from "@/lib/auth/permissions";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import { parseSidebarVariant, SIDEBAR_VARIANT_COOKIE } from "@/lib/navigation/sidebar-variant";
import { hasNavPermission } from "@/lib/navigation/nav-items";
import type { CurrentUser } from "@/lib/auth/session";

export async function AppShell({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  // Effective permissions (role + per-user overrides, filtered by channel
  // scope — docs/adr/0039), so the sidebar shows exactly what the server
  // will actually allow.
  const permissions = new Set(user.permissions);
  const cookieStore = await cookies();
  const [{ items, unreadCount }, supportConfig, announcement, companyLogo] = await Promise.all([
    getRecentNotifications(user.id),
    getSupportConfig(),
    // Platform announcement (docs/adr/0059): the one live announcement this
    // browser hasn't dismissed — null renders nothing at all.
    getActiveAnnouncement(parseDismissedCookie(cookieStore.get(ANNOUNCEMENT_DISMISS_COOKIE)?.value)),
    // The company's own logo, only when the platform granted it (null = ASODITECH).
    getShellLogo(user.tenantId),
  ]);
  const canUseAi = userHasPermission(user, "ai.use");
  // Server-read so the very first paint already reflects the viewer's
  // saved sidebar-collapse preference — no client-only effect, no flash.
  const sidebarCollapsed = cookieStore.get("sidebar-collapsed")?.value === "1";
  // Sidebar presentation experiment — same per-browser cookie mechanism, opt-in
  // from the user menu; absent = the current sidebar (src/lib/navigation/sidebar-variant.ts).
  const sidebarVariant = parseSidebarVariant(cookieStore.get(SIDEBAR_VARIANT_COOKIE)?.value);
  // Topbar primary action — the existing « Nouvelle opération » page, shown
  // with exactly the permission rule of its sidebar entry (nav-items.ts).
  const canCreate = hasNavPermission(permissions, ["orders.create", "sales.create"]);

  return (
    <SidebarShell
      permissions={permissions}
      favorites={user.navFavorites}
      defaultCollapsed={sidebarCollapsed}
      variant={sidebarVariant}
      companyLogo={companyLogo}
    >
      {/* Top announcement bar — first in the content column, above the sticky header, in normal flow (scrolls away; the header stays sticky; the fixed sidebar is untouched).
          Keyed by id + last edit: a different (or edited) announcement remounts the bar, so a previous dismissal's local state never hides it. */}
      {announcement && <AnnouncementBar key={announcement.key} announcement={announcement} />}
      {/* Soft UI topbar: no bottom border — separated from the page by spacing and the background change (white shell → grey content). */}
      <header className="z-30 flex h-[72px] shrink-0 items-center gap-2 bg-shell px-3 sm:gap-3 md:px-8">
        <MobileNav permissions={permissions} favorites={user.navFavorites} variant={sidebarVariant} companyLogo={companyLogo} />
        <div className="lg:hidden">
          <Link href="/tableau-de-bord" aria-label="Tableau de bord">
            {companyLogo ? (
              <CompanyLogo src={companyLogo.src} companyName={companyLogo.companyName} compact fallback={<BrandMark variant="icon" />} />
            ) : (
              <BrandMark variant="icon" />
            )}
          </Link>
        </div>
        <CommandPalette permissions={permissions} />
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          {canCreate && (
            <Link
              href="/operations/nouvelle"
              aria-label="Nouvelle opération"
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-control bg-brand px-3 text-sm font-semibold whitespace-nowrap sm:h-11 text-primary-foreground shadow-soft transition-colors duration-150 hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-4"
            >
              <Plus className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Nouvelle opération</span>
            </Link>
          )}
          <ThemeToggle />
          <NotificationSoundListener />
          <NotificationBell items={items} unreadCount={unreadCount} />
          <UserMenu name={user.name} role={USER_ROLE_LABELS[user.role]} sidebarVariant={sidebarVariant} />
        </div>
      </header>
      {/* The content column is the scroll container (the shell itself stays put). pb clears
          the floating « Centre d'aide » button so the last row — pagination « Suivant », a
          form's FormActions — stays clickable; the IntegrationsFooter below stays at the
          bottom of the column, never over the end of the page. */}
      <main className="min-h-0 flex-1 overflow-y-auto bg-content px-4 pt-6 pb-[calc(6rem+env(safe-area-inset-bottom))] [scrollbar-gutter:stable] md:px-8 md:pt-8 md:pb-28">
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
