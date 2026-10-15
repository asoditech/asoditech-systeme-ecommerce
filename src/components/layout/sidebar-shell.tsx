"use client";

import { useState } from "react";
import Link from "next/link";
import { LifeBuoy, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { ThemeSegmented } from "@/components/layout/theme-segmented";
import { BrandMark } from "@/components/brand-mark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { openSupportWidget } from "@/lib/support/open-support";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/auth/permissions";
import type { SidebarVariant } from "@/lib/navigation/sidebar-variant";

const COOKIE_NAME = "sidebar-collapsed";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const bottomRow =
  "flex items-center rounded-control text-sm font-medium text-ink-secondary transition-colors duration-150 hover:bg-nav-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * The Soft UI app frame (redesign/soft-ui): the whole app sits in a white,
 * rounded shell floating on the grey page (gap and radius: --shell-gap /
 * --shell-radius in globals.css; full-bleed on mobile), the
 * sidebar on its left and the content column (children: topbar, page, footer)
 * on its right — only the content column scrolls.
 *
 * Sidebar collapse: an icon-only 72px rail (tooltips; « sections » open as a
 * floating card). Purely a per-viewer UI preference: it changes nothing about
 * navigation, permissions, or which routes exist. `defaultCollapsed` is read
 * server-side from a plain cookie by AppShell — deliberately NOT localStorage,
 * so the first server paint already reflects the saved preference with no
 * flash; toggling updates local state immediately and best-effort persists
 * the same cookie for the next server render.
 */
export function SidebarShell({
  permissions,
  favorites = [],
  defaultCollapsed = false,
  variant = "classic",
  nav: CustomNav,
  brandBadge,
  homeHref = "/tableau-de-bord",
  showHelp = true,
  children,
}: {
  permissions: Set<Permission>;
  favorites?: string[];
  defaultCollapsed?: boolean;
  /** Sidebar presentation experiment (src/lib/navigation/sidebar-variant.ts), read server-side from its cookie. */
  variant?: SidebarVariant;
  /** Optional other navigation (the /platform area) in place of the merchant SidebarNav. */
  nav?: React.ComponentType<{ collapsed?: boolean }>;
  /** Small pill shown beside the logo when the sidebar is expanded (e.g. « Plateforme »). */
  brandBadge?: React.ReactNode;
  homeHref?: string;
  /** « Centre d'aide » row — off where the support widget is not mounted. */
  showHelp?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        document.cookie = `${COOKIE_NAME}=${next ? "1" : "0"}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
      } catch {
        // Best-effort only — the toggle still works for this page view;
        // it just won't be remembered on the next full navigation.
      }
      return next;
    });
  }

  const help = (
    <>
      <LifeBuoy className="size-5 shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">Centre d&apos;aide</span>}
    </>
  );

  return (
    <div className="h-dvh overflow-hidden bg-page p-(--shell-gap)">
      <div data-app-shell="" data-sidebar-collapsed={collapsed || undefined} className="group/shell flex h-full min-h-0 overflow-hidden rounded-(--shell-radius) bg-shell md:shadow-shell">
        <aside
          className={cn(
            "hidden h-full shrink-0 flex-col bg-shell transition-[width] duration-200 ease-out motion-reduce:transition-none lg:flex",
            collapsed ? "w-[72px]" : "w-[272px]"
          )}
        >
          <div className={cn("flex h-[72px] shrink-0 items-center gap-2.5", collapsed ? "justify-center" : "px-7")}>
            <Link href={homeHref} aria-label="Tableau de bord" className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              <BrandMark variant={collapsed ? "icon" : "compact"} />
            </Link>
            {!collapsed && brandBadge}
          </div>

          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto pb-2">
            {CustomNav ? (
              <CustomNav collapsed={collapsed} />
            ) : (
              <SidebarNav permissions={permissions} favorites={favorites} collapsed={collapsed} variant={variant} />
            )}
          </div>

          <div className={cn("flex shrink-0 flex-col gap-2 border-t border-hairline", collapsed ? "items-center px-3 py-3" : "px-4 py-4")}>
            {!showHelp ? null : collapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={<button type="button" onClick={() => openSupportWidget()} aria-label="Centre d'aide" className={cn(bottomRow, "size-11 justify-center")} />}
                >
                  {help}
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={10}>
                  Centre d&apos;aide
                </TooltipContent>
              </Tooltip>
            ) : (
              <button type="button" onClick={() => openSupportWidget()} className={cn(bottomRow, "h-11 gap-3 px-3")}>
                {help}
              </button>
            )}

            <ThemeSegmented compact={collapsed} />

            <button
              type="button"
              onClick={toggle}
              aria-pressed={collapsed}
              title={collapsed ? "Agrandir le menu" : "Réduire le menu"}
              className={cn(bottomRow, collapsed ? "size-11 justify-center" : "h-10 gap-3 px-3")}
            >
              {collapsed ? <PanelLeftOpen className="size-5" aria-hidden="true" /> : <PanelLeftClose className="size-5" aria-hidden="true" />}
              {!collapsed && <span>Réduire</span>}
            </button>
          </div>
        </aside>

        <div data-app-content="" className="flex min-w-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
