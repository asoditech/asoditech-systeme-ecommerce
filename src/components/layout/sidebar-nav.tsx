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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NavBadge } from "@/components/layout/nav-badge";

// The navigation list itself lives in src/lib/navigation/nav-items.ts
// (shared with the global search and favorites) — re-exported here for the
// existing imports.
export { NAV_GROUPS, hasNavPermission, hasDomainAccess, visibleNavGroups } from "@/lib/navigation/nav-items";

/**
 * Sidebar navigation — Soft UI (redesign/soft-ui). Presentation only: every
 * href, permission filter, active-route rule and favourite action is the same
 * as before.
 * - classic (default): sentence-case section labels that fold, icon rows;
 * - « sections » (per-browser cookie): one row per business section whose
 *   items hang off a thin tree line with curved connectors (Brainwave style).
 * Idle rows are transparent, hover is a very light grey, the active row is a
 * light grey pill with a soft shadow — never the orange.
 * `collapsed`: the 72px icon rail — tooltips on every icon, and in « sections »
 * each section opens as a floating card next to the rail.
 */
export function SidebarNav({
  permissions,
  onNavigate,
  collapsed = false,
  favorites: storedFavorites = [],
  variant = "classic",
  badges = {},
}: {
  permissions: Set<Permission>;
  /** Presentation experiment (src/lib/navigation/sidebar-variant.ts): the same
   * items, links and permissions, regrouped into « sections » with a stronger
   * hierarchy. Default « classic ». */
  variant?: SidebarVariant;
  onNavigate?: () => void;
  /** The user's stored « Favoris » hrefs (User.navFavorites), in order. Only
   * the ones they may open now are shown (visibleFavoriteItems). */
  favorites?: string[];
  /** Icon-only rail for the desktop sidebar. Never passed by `MobileNav`'s
   * drawer. Purely visual: every href, permission, and active-state rule
   * below is unchanged. */
  collapsed?: boolean;
  /** Optional per-href counts shown as pastel chips (NavBadge). Not wired to
   * any data yet — nothing passes it. */
  badges?: Readonly<Record<string, number>>;
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
  // Folded / unfolded groups, per label — only what the viewer toggled; the
  // default is « open » (classic) / « the section of the current page » (sections).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  function isActive(href: string) {
    return (
      pathname === href ||
      (pathname.startsWith(href + "/") &&
        !allHrefs.some((h) => h !== href && h.startsWith(href + "/") && (pathname === h || pathname.startsWith(h + "/"))))
    );
  }

  function isOpen(group: NavGroup) {
    const fallback = sectioned ? group.items.some((i) => isActive(i.href)) : true;
    return toggled[group.label] ?? fallback;
  }

  function toggleGroup(group: NavGroup) {
    const next = !isOpen(group);
    setToggled((prev) => ({ ...prev, [group.label]: next }));
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

  /**
   * One nav row. `sub`: a « sections » child (text only, muted until active).
   * `favoriteRow`: a « Favoris » row, whose three controls (monter, descendre,
   * retirer — about 70px) need more room than a single star: the label stops
   * before them wherever they show (always on touch, on hover/focus from md).
   */
  function renderLink(item: NavItem, opts: { sub?: boolean; favoriteRow?: boolean } = {}) {
    const active = isActive(item.href);
    const Icon = item.icon;
    const className = cn(
      "relative flex min-w-0 items-center rounded-control text-sm font-medium transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      collapsed ? "size-11 shrink-0 justify-center" : cn("flex-1 gap-3 pr-9 pl-3", opts.sub ? "h-10" : "h-11"),
      !collapsed && opts.favoriteRow && "pr-[4.75rem] md:pr-9 md:group-focus-within/nav:pr-[4.75rem] md:group-hover/nav:pr-[4.75rem]",
      active
        ? "bg-nav-active text-ink shadow-soft"
        : opts.sub
          ? "text-ink-muted hover:bg-nav-hover hover:text-ink"
          : "text-ink-secondary hover:bg-nav-hover hover:text-ink"
    );
    const content = (
      <>
        {!opts.sub && <Icon className={cn("size-5 shrink-0", active && "text-ink")} aria-hidden="true" />}
        {!collapsed && <span className="truncate">{item.label}</span>}
        {!collapsed && <NavBadge count={badges[item.href]} className="ml-auto" />}
      </>
    );
    if (!collapsed) {
      return (
        <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={className}>
          {content}
        </Link>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={item.label} className={className} />
          }
        >
          {content}
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10}>
          {item.label}
        </TooltipContent>
      </Tooltip>
    );
  }

  /** Pin / unpin button, shown on hover or keyboard focus (always on touch: no hover there). */
  function renderPin(item: NavItem) {
    const pinned = favorites.includes(item.href);
    return (
      <button
        type="button"
        onClick={() => toggle(item)}
        disabled={pending}
        aria-pressed={pinned}
        aria-label={pinned ? `Retirer « ${item.label} » des favoris` : `Ajouter « ${item.label} » aux favoris`}
        title={pinned ? "Retirer des favoris" : "Ajouter aux favoris"}
        className={cn(
          "absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-ink-faint transition-opacity duration-150 hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
          pinned ? "opacity-100" : "opacity-100 md:opacity-0 md:group-hover/nav:opacity-100"
        )}
      >
        <Star className={cn("size-3.5", pinned && "fill-brand text-brand")} aria-hidden="true" />
      </button>
    );
  }

  /** Sentence-case, muted group label — a button that folds its group (classic). */
  function renderGroupLabel(group: NavGroup, open: boolean, controls: string) {
    return (
      <button
        type="button"
        onClick={() => toggleGroup(group)}
        aria-expanded={open}
        aria-controls={controls}
        className="flex h-7 w-full items-center justify-between rounded-lg px-3 text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink focus-visible:outline-2 focus-visible:outline-ring"
      >
        {group.label}
        <ChevronDown className={cn("size-3.5 transition-transform duration-150", !open && "-rotate-90")} aria-hidden="true" />
      </button>
    );
  }

  /** A « sections » child row with its tree connector (curved elbow; the vertical line continues for all but the last). */
  function renderTreeItem(item: NavItem, last: boolean) {
    return (
      <li
        key={item.href}
        className={cn(
          "group/nav relative flex items-center pl-5",
          "before:pointer-events-none before:absolute before:top-0 before:left-0 before:h-1/2 before:w-3.5 before:rounded-bl-[10px] before:border-b before:border-l before:border-ink-faint/45",
          !last && "after:pointer-events-none after:absolute after:inset-y-0 after:left-0 after:border-l after:border-ink-faint/45"
        )}
        data-nav-tree-item=""
      >
        {renderLink(item, { sub: true })}
        {renderPin(item)}
      </li>
    );
  }

  const groupId = (label: string) => `nav-group-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <nav className={cn("flex flex-col", collapsed ? "items-center gap-3 px-3 py-2" : "gap-5 px-4 py-2")} data-sidebar-variant={variant}>
      {favoriteItems.length > 0 && (
        <div className={cn("flex flex-col gap-1", collapsed && "items-center")} aria-label="Favoris" role="group">
          {!collapsed && (
            <p className="flex h-7 items-center gap-1.5 px-3 text-xs font-medium text-ink-muted">
              <Star className="size-3.5" aria-hidden="true" />
              Favoris
            </p>
          )}
          {favoriteItems.map((item, index) => (
            <div key={`fav-${item.href}`} className="group/nav relative flex items-center">
              {renderLink(item, { favoriteRow: true })}
              {!collapsed && (
                <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-0.5 opacity-100 md:opacity-0 md:group-focus-within/nav:opacity-100 md:group-hover/nav:opacity-100">
                  <button
                    type="button"
                    onClick={() => move(item, -1)}
                    disabled={pending || index === 0}
                    aria-label={`Monter « ${item.label} »`}
                    className="flex size-5 items-center justify-center rounded text-ink-faint hover:text-ink disabled:opacity-30"
                  >
                    <ChevronUp className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(item, 1)}
                    disabled={pending || index === favoriteItems.length - 1}
                    aria-label={`Descendre « ${item.label} »`}
                    className="flex size-5 items-center justify-center rounded text-ink-faint hover:text-ink disabled:opacity-30"
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
                    <Star className="size-3.5 fill-brand text-brand" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {groups.map((group, index) => {
        const open = isOpen(group);
        const id = groupId(group.label);
        const hasActive = group.items.some((i) => isActive(i.href));

        // ---- collapsed rail ------------------------------------------------
        if (collapsed) {
          if (sectioned && "icon" in group) {
            const SectionIcon = group.icon;
            return (
              <div key={group.label} role="group" aria-label={group.label} className="flex flex-col items-center">
                {index > 0 || favoriteItems.length > 0 ? <div className="mb-3 h-px w-8 bg-hairline" aria-hidden="true" /> : null}
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    delay={80}
                    aria-label={group.label}
                    className={cn(
                      "flex size-11 items-center justify-center rounded-control transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      hasActive ? "bg-nav-active text-ink shadow-soft" : "text-ink-secondary hover:bg-nav-hover hover:text-ink"
                    )}
                  >
                    <SectionIcon className="size-5" aria-hidden="true" />
                  </PopoverTrigger>
                  <PopoverContent side="right" align="start" sideOffset={14} className="w-60 rounded-tile border-0 p-2 shadow-popover">
                    <p className="px-3 pt-1 pb-1.5 text-xs font-medium text-ink-muted">{group.label}</p>
                    <div className="flex flex-col gap-0.5">
                      {group.items.map((item) => {
                        const active = isActive(item.href);
                        return (
                          <Link
                            key={item.href}
                            href={item.href}
                            onClick={onNavigate}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "flex h-10 items-center rounded-control px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
                              active ? "bg-nav-active text-ink shadow-soft" : "text-ink-secondary hover:bg-nav-hover hover:text-ink"
                            )}
                          >
                            <span className="truncate">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
            );
          }
          return (
            <div key={group.label} role="group" aria-label={group.label} className="flex flex-col items-center gap-1">
              {index > 0 || favoriteItems.length > 0 ? <div className="mb-2 h-px w-8 bg-hairline" aria-hidden="true" /> : null}
              {group.items.map((item) => (
                <div key={item.href} className="flex">
                  {renderLink(item)}
                </div>
              ))}
            </div>
          );
        }

        // ---- « sections »: parent row + tree -------------------------------
        if (sectioned && "icon" in group) {
          const SectionIcon = group.icon;
          return (
            <div key={group.label} role="group" aria-label={group.label} className="flex flex-col">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                aria-expanded={open}
                aria-controls={id}
                className={cn(
                  "flex h-11 w-full items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors duration-150 hover:bg-nav-hover focus-visible:outline-2 focus-visible:outline-ring",
                  hasActive ? "text-ink" : "text-ink-secondary hover:text-ink"
                )}
              >
                <SectionIcon className="size-5 shrink-0" aria-hidden="true" />
                <span className="truncate">{group.label}</span>
                <ChevronDown className={cn("ml-auto size-4 text-ink-faint transition-transform duration-150", open && "rotate-180")} aria-hidden="true" />
              </button>
              <div id={id} className="nav-collapse" data-open={open} inert={!open}>
                <div>
                  <ul className="relative mt-1 ml-[1.375rem] flex flex-col gap-0.5">
                    {group.items.map((item, i) => renderTreeItem(item, i === group.items.length - 1))}
                  </ul>
                </div>
              </div>
            </div>
          );
        }

        // ---- classic: folding section label + icon rows --------------------
        return (
          <div key={group.label} role="group" aria-label={group.label} className="flex flex-col gap-1">
            {renderGroupLabel(group, open, id)}
            <div id={id} className="nav-collapse" data-open={open} inert={!open}>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <div key={item.href} className="group/nav relative flex items-center">
                    {renderLink(item)}
                    {renderPin(item)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}
