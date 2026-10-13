"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronUp, Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/auth/permissions";
import { NAV_GROUPS, visibleNavGroups, type NavGroup, type NavItem } from "@/lib/navigation/nav-items";
import { sectionedNavGroups, type SectionedNavGroup, type SidebarVariant } from "@/lib/navigation/sidebar-variant";
import { visibleFavoriteItems } from "@/lib/navigation/favorites";
import { moveMyFavoriteAction, toggleMyFavoriteAction } from "@/actions/favorites";

// The navigation list itself lives in src/lib/navigation/nav-items.ts
// (shared with the global search and favorites) — re-exported here for the
// existing imports.
export { NAV_GROUPS, hasNavPermission, hasDomainAccess, visibleNavGroups } from "@/lib/navigation/nav-items";

export function SidebarNav({
  permissions,
  onNavigate,
  collapsed = false,
  favorites: storedFavorites = [],
  variant = "classic",
}: {
  permissions: Set<Permission>;
  /** Presentation experiment (src/lib/navigation/sidebar-variant.ts): the same
   * items, links and permissions, regrouped into « sections » with a stronger
   * hierarchy. Default « classic » = the current sidebar. */
  variant?: SidebarVariant;
  onNavigate?: () => void;
  /** The user's stored « Favoris » hrefs (User.navFavorites), in order. Only
   * the ones they may open now are shown (visibleFavoriteItems). */
  favorites?: string[];
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
  const sectioned = variant === "sections";
  const groups: (NavGroup | SectionedNavGroup)[] = sectioned ? sectionedNavGroups(permissions) : visibleNavGroups(permissions);
  // Optimistic copy of the stored list; the server action is the authority
  // (it re-applies the same rules and returns the saved list).
  const [favorites, setFavorites] = useState<string[]>(storedFavorites);
  const [pending, startTransition] = useTransition();
  const favoriteItems = visibleFavoriteItems(favorites, permissions);

  function isActive(href: string) {
    return (
      pathname === href ||
      (pathname.startsWith(href + "/") &&
        !allHrefs.some((h) => h !== href && h.startsWith(href + "/") && (pathname === h || pathname.startsWith(h + "/"))))
    );
  }

  function toggle(item: NavItem) {
    const before = favorites;
    setFavorites(before.includes(item.href) ? before.filter((h) => h !== item.href) : [...before, item.href]);
    startTransition(async () => {
      const res = await toggleMyFavoriteAction(item.href);
      if (res.ok) setFavorites(res.data.favorites);
      else {
        setFavorites(before);
        toast.error(res.error);
      }
    });
  }

  function move(item: NavItem, direction: -1 | 1) {
    startTransition(async () => {
      const res = await moveMyFavoriteAction(item.href, direction);
      if (res.ok) setFavorites(res.data.favorites);
      else toast.error(res.error);
    });
  }

  /** `onRail`: a « sections » item under its heading's rail — the only place its active accent bar belongs (not in Favoris, not collapsed). */
  /**
   * `favoriteRow`: a « Favoris » row, whose three controls (monter, descendre,
   * retirer — about 70px) need more room than a single star: the label stops
   * before them wherever they show (always on touch, on hover/focus from md).
   */
  function renderLink(item: NavItem, onRail = false, favoriteRow = false) {
    const active = isActive(item.href);
    const Icon = item.icon;
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        title={collapsed ? item.label : undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          // Phase 4 (Complete Product UI/UX Visual Redesign) — a solid
          // brand-orange pill for the active item (not a tint + thin
          // bar): the nav should read as confidently as any other
          // "selected" state in a premium SaaS shell (Linear/Vercel-
          // style), visible at a glance even collapsed to icons only.
          "relative flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 text-sm font-medium transition-colors",
          collapsed ? "justify-center px-2" : sectioned ? "gap-2 pr-8 pl-2" : "pr-8 pl-3",
          !collapsed && favoriteRow && "pr-[4.75rem] md:pr-8 md:group-focus-within/nav:pr-[4.75rem] md:group-hover/nav:pr-[4.75rem]",
          sectioned
            ? // « sections » experiment: a tinted row with a brand accent bar
              // on the section's rail instead of the solid pill.
              active
              ? cn(
                  "bg-primary/10 font-semibold text-primary",
                  onRail && "before:absolute before:inset-y-1.5 before:-left-[5px] before:w-0.5 before:rounded-full before:bg-primary"
                )
              : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            : active
              ? "bg-primary text-primary-foreground shadow-sm shadow-primary/25"
              : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Icon className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </Link>
    );
  }

  /** Pin / unpin button, shown on hover or keyboard focus (always on touch: no hover there). */
  function renderPin(item: NavItem) {
    const pinned = favorites.includes(item.href);
    const active = isActive(item.href);
    return (
      <button
        type="button"
        onClick={() => toggle(item)}
        disabled={pending}
        aria-pressed={pinned}
        aria-label={pinned ? `Retirer « ${item.label} » des favoris` : `Ajouter « ${item.label} » aux favoris`}
        title={pinned ? "Retirer des favoris" : "Ajouter aux favoris"}
        className={cn(
          "absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md transition-opacity focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
          pinned ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/nav:opacity-100",
          active && !sectioned ? "text-primary-foreground/80 hover:text-primary-foreground" : "text-sidebar-foreground/45 hover:text-amber-500"
        )}
      >
        <Star className={cn("size-3.5", pinned && "fill-amber-400 text-amber-400")} aria-hidden="true" />
      </button>
    );
  }

  /** « sections » heading: an icon tile + a readable label (classic keeps its small caps label). */
  function renderSectionHeading(label: string, Icon: typeof Star) {
    return (
      <p className="flex items-center gap-2 px-1 pb-1.5 text-xs font-semibold text-sidebar-foreground">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary" aria-hidden="true">
          <Icon className="size-3.5" />
        </span>
        {label}
      </p>
    );
  }

  return (
    <nav className={cn("flex flex-col p-3", sectioned ? "gap-5" : "gap-4")} data-sidebar-variant={variant}>
      {favoriteItems.length > 0 && (
        <div className="flex flex-col gap-0.5" aria-label="Favoris" role="group">
          {!collapsed &&
            (sectioned ? (
              renderSectionHeading("Favoris", Star)
            ) : (
              <p className="px-2.5 pb-1 text-[0.65rem] font-semibold tracking-wider text-sidebar-foreground/45 uppercase">Favoris</p>
            ))}
          {favoriteItems.map((item, index) => (
            <div key={`fav-${item.href}`} className="group/nav relative flex items-center">
              {renderLink(item, false, true)}
              {!collapsed && (
                <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 opacity-100 md:opacity-0 md:group-focus-within/nav:opacity-100 md:group-hover/nav:opacity-100">
                  <button
                    type="button"
                    onClick={() => move(item, -1)}
                    disabled={pending || index === 0}
                    aria-label={`Monter « ${item.label} »`}
                    className="flex size-5 items-center justify-center rounded text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30"
                  >
                    <ChevronUp className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(item, 1)}
                    disabled={pending || index === favoriteItems.length - 1}
                    aria-label={`Descendre « ${item.label} »`}
                    className="flex size-5 items-center justify-center rounded text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30"
                  >
                    <ChevronDown className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggle(item)}
                    disabled={pending}
                    aria-label={`Retirer « ${item.label} » des favoris`}
                    className="flex size-5 items-center justify-center rounded"
                  >
                    <Star className="size-3.5 fill-amber-400 text-amber-400" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {groups.map((group, index) =>
        sectioned && "icon" in group ? (
          <div key={group.label} role="group" aria-label={group.label} className="flex flex-col">
            {collapsed ? (
              index > 0 && <div className="mx-2 mb-2 border-t border-sidebar-border" aria-hidden="true" />
            ) : (
              renderSectionHeading(group.label, group.icon)
            )}
            {/* The section's items hang off a rail under its heading. */}
            <div className={cn("flex flex-col gap-0.5", !collapsed && "ml-3 border-l border-sidebar-border pl-1")}>
              {group.items.map((item) => (
                <div key={item.href} className="group/nav relative flex items-center">
                  {renderLink(item, !collapsed)}
                  {!collapsed && renderPin(item)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div key={group.label} className="flex flex-col gap-0.5">
            {!collapsed && (
              <p className="px-2.5 pb-1 text-[0.65rem] font-semibold tracking-wider text-sidebar-foreground/45 uppercase">
                {group.label}
              </p>
            )}
            {group.items.map((item) => (
              <div key={item.href} className="group/nav relative flex items-center">
                {renderLink(item)}
                {!collapsed && renderPin(item)}
              </div>
            ))}
          </div>
        )
      )}
    </nav>
  );
}
