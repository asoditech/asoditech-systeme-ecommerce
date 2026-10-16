"use client";

import Link from "next/link";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { MobileNav } from "@/components/layout/mobile-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { BrandMark } from "@/components/brand-mark";
import { PlatformBadge, PlatformNav } from "@/components/platform/platform-nav";

const NO_PERMISSIONS = new Set<never>();

/**
 * The /platform frame: the merchant app's Soft UI shell (floating white
 * shell, 272px / rail sidebar, drawer below 1024px, same topbar metrics) with
 * the platform navigation and the « Plateforme » badge. `actions` are the
 * server-rendered topbar controls (lock, sign out).
 */
export function PlatformShell({
  defaultCollapsed,
  actions,
  children,
}: {
  defaultCollapsed: boolean;
  actions: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <SidebarShell
      permissions={NO_PERMISSIONS}
      defaultCollapsed={defaultCollapsed}
      nav={PlatformNav}
      brandBadge={<PlatformBadge />}
      homeHref="/platform"
    >
      <header className="z-30 flex h-[72px] shrink-0 items-center gap-2 bg-shell px-3 sm:gap-3 md:px-8">
        <MobileNav permissions={NO_PERMISSIONS} nav={PlatformNav} brandBadge={<PlatformBadge />} homeHref="/platform" />
        <div className="flex items-center gap-2 lg:hidden">
          <Link href="/platform" aria-label="Tenants">
            <BrandMark variant="icon" />
          </Link>
          <PlatformBadge />
        </div>
        {/* Rail mode hides the sidebar badge: show it in the topbar instead. */}
        <span className="hidden lg:group-data-[sidebar-collapsed]/shell:inline-flex">
          <PlatformBadge />
        </span>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          {actions}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto bg-content px-4 pt-6 pb-16 [scrollbar-gutter:stable] md:px-8 md:pt-8">
        <div className="mx-auto w-full max-w-[1600px]">{children}</div>
      </main>
    </SidebarShell>
  );
}
