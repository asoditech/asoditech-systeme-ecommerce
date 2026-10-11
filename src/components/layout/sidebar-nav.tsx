"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/auth/permissions";
import { NAV_GROUPS, visibleNavGroups } from "@/lib/navigation/nav-items";

// The navigation list itself lives in src/lib/navigation/nav-items.ts
// (shared with the global search and favorites) — re-exported here for the
// existing imports.
export { NAV_GROUPS, hasNavPermission, hasDomainAccess, visibleNavGroups } from "@/lib/navigation/nav-items";

export function SidebarNav({
  permissions,
  onNavigate,
  collapsed = false,
}: {
  permissions: Set<Permission>;
  onNavigate?: () => void;
  /** Icon-only mode for the desktop sidebar (docs — sidebar collapse
   * toggle). Never passed by `MobileNav`'s drawer — a temporary overlay
   * has no reason to hide its own labels. Purely visual: every href,
   * permission, and active-state rule below is unchanged. */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  // Every nav href, so a parent (e.g. /livraison) doesn't stay highlighted
  // when a more specific sibling (e.g. /livraison/suivi) is the real match.
  const allHrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
  const groups = visibleNavGroups(permissions);

  return (
    <nav className="flex flex-col gap-4 p-3">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          {!collapsed && (
            <p className="px-2.5 pb-1 text-[0.65rem] font-semibold tracking-wider text-sidebar-foreground/45 uppercase">
              {group.label}
            </p>
          )}
          {group.items.map((item) => {
            const isActive =
              pathname === item.href ||
              (pathname.startsWith(item.href + "/") &&
                !allHrefs.some(
                  (href) =>
                    href !== item.href &&
                    href.startsWith(item.href + "/") &&
                    (pathname === href || pathname.startsWith(href + "/"))
                ));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={cn(
                  // Phase 4 (Complete Product UI/UX Visual Redesign) — a solid
                  // brand-orange pill for the active item (not a tint + thin
                  // bar): the nav should read as confidently as any other
                  // "selected" state in a premium SaaS shell (Linear/Vercel-
                  // style), visible at a glance even collapsed to icons only.
                  "relative flex items-center gap-2.5 rounded-lg py-1.5 text-sm font-medium transition-colors",
                  collapsed ? "justify-center px-2" : "pr-2.5 pl-3",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm shadow-primary/25"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
