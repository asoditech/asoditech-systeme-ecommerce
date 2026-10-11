import { NAV_GROUPS, visibleNavGroups, type NavItem } from "@/lib/navigation/nav-items";
import type { Permission } from "@/lib/auth/permissions";

/**
 * « Favoris » — a user's pinned pages, in their order. Pure rules shared by
 * the server action that stores them and the sidebar that shows them:
 *  - only real sidebar destinations (NAV_GROUPS hrefs) are ever STORED —
 *    never an arbitrary URL;
 *  - at most MAX_FAVORITES, no duplicates, order kept;
 *  - SHOWN only while the user may still open the page (the sidebar's own
 *    permission rule). A page hidden after a permission change keeps its
 *    stored place — it comes back if the permission does — and hiding it
 *    never grants anything: the page re-checks on the server.
 */
export const MAX_FAVORITES = 8;

const KNOWN_HREFS = new Set(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)));

/** Cleans a stored or submitted list: known destinations only, no duplicates, capped. */
export function sanitizeFavorites(hrefs: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const h of hrefs) {
    if (typeof h !== "string" || !KNOWN_HREFS.has(h) || out.includes(h)) continue;
    out.push(h);
    if (out.length === MAX_FAVORITES) break;
  }
  return out;
}

export type FavoriteChange =
  | { ok: true; favorites: string[] }
  | { ok: false; error: string };

/** Pins or unpins a page (the user must be able to see it to pin it). */
export function toggleFavorite(current: readonly string[], href: string, permissions: ReadonlySet<Permission>): FavoriteChange {
  const list = sanitizeFavorites(current);
  if (list.includes(href)) return { ok: true, favorites: list.filter((h) => h !== href) };
  if (!visibleFavoriteItems([href], permissions).length) return { ok: false, error: "Cette page n'est pas disponible pour votre compte." };
  if (list.length >= MAX_FAVORITES) return { ok: false, error: `Vous avez déjà ${MAX_FAVORITES} favoris : retirez-en un d'abord.` };
  return { ok: true, favorites: [...list, href] };
}

/** Moves a pinned page one place up (-1) or down (+1); out of range = unchanged. */
export function moveFavorite(current: readonly string[], href: string, direction: -1 | 1): string[] {
  const list = sanitizeFavorites(current);
  const i = list.indexOf(href);
  const j = i + direction;
  if (i === -1 || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j]!, list[i]!];
  return list;
}

/** The pinned pages this user may open now, in the stored order, with their sidebar label and icon. */
export function visibleFavoriteItems(stored: readonly string[], permissions: ReadonlySet<Permission>): NavItem[] {
  const visible = new Map(visibleNavGroups(permissions).flatMap((g) => g.items.map((i) => [i.href, i] as const)));
  return sanitizeFavorites(stored)
    .map((h) => visible.get(h))
    .filter((i): i is NavItem => i !== undefined);
}
