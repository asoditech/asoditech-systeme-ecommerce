"use client";

import { useState } from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { BrandMark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/auth/permissions";

const COOKIE_NAME = "sidebar-collapsed";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Desktop sidebar collapse toggle — icon-only mode for a denser,
 * "professional" layout, on request. Purely a per-viewer UI preference:
 * it changes nothing about navigation, permissions, or which routes
 * exist, only how much horizontal space the nav itself takes.
 *
 * `defaultCollapsed` is read server-side from a plain cookie by the
 * caller (AppShell, an async Server Component: `(await
 * cookies()).get("sidebar-collapsed")?.value === "1"`) — deliberately
 * NOT localStorage, so the very first server-rendered paint already
 * reflects the viewer's saved preference with no flash and no
 * client-only effect syncing state from an external store (which would
 * either mismatch the server's HTML on hydration, or need a
 * `useSyncExternalStore` subscription for a value that only this one
 * button ever writes). Toggling updates local state immediately for a
 * snappy UI, and best-effort persists the same cookie for the next
 * server render / navigation.
 *
 * Owns the collapsed state for BOTH the `<aside>` and the content
 * column's left padding in one client component, since they're siblings
 * under the (server) AppShell and must resize together — no
 * CSS-variable or context indirection needed.
 */
export function SidebarShell({
  permissions,
  defaultCollapsed = false,
  children,
}: {
  permissions: Set<Permission>;
  defaultCollapsed?: boolean;
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

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-150 md:flex",
          collapsed ? "w-16" : "w-64"
        )}
      >
        <div className={cn("flex h-14 shrink-0 items-center border-b border-sidebar-border", collapsed ? "justify-center px-2" : "px-4")}>
          <Link href="/tableau-de-bord" aria-label="Tableau de bord">
            <BrandMark variant={collapsed ? "icon" : "compact"} />
          </Link>
        </div>
        <div className="sidebar-scroll flex-1 overflow-y-auto">
          <SidebarNav permissions={permissions} collapsed={collapsed} />
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-pressed={collapsed}
          title={collapsed ? "Agrandir le menu" : "Réduire le menu"}
          className="flex h-10 shrink-0 items-center justify-center gap-2 border-t border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          {!collapsed && <span className="text-xs font-medium">Réduire</span>}
        </button>
      </aside>
      <div className={cn("flex min-w-0 flex-1 flex-col transition-[padding] duration-150", collapsed ? "md:pl-16" : "md:pl-64")}>
        {children}
      </div>
    </div>
  );
}
