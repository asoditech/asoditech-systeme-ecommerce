import { Boxes, Home, Layers, Settings, ShoppingCart, Truck, Wallet } from "lucide-react";
import type { Permission } from "@/lib/auth/permissions";
import { NAV_GROUPS, visibleNavGroups, type NavGroup, type NavItem } from "./nav-items";

/**
 * Sidebar presentation experiment (reversible). Two looks for the SAME
 * navigation: « classic » (NAV_GROUPS as they are) and « sections » (the same
 * items regrouped under clearer business sections with a stronger hierarchy).
 *
 * Only the presentation changes. Every link, label, icon, permission and
 * channel domain still comes from NAV_GROUPS (nav-items.ts) — the sections
 * below hold hrefs only, and `sectionedNavGroups` builds them from the items
 * `visibleNavGroups` already allowed. Global search, favourites and every
 * page's own server-side permission check are untouched.
 *
 * The choice is a per-browser cookie read by AppShell (like `sidebar-collapsed`):
 * no database field, nothing stored on the tenant. Default = classic.
 * To remove the experiment: delete this file's sections + the `variant`
 * branches in sidebar-nav.tsx and the toggle in user-menu.tsx.
 */
export type SidebarVariant = "classic" | "sections";

export const SIDEBAR_VARIANT_COOKIE = "sidebar-variant";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Only an explicit opt-in shows the experiment; anything else (absent, unknown) is the current sidebar. */
export function parseSidebarVariant(value: string | undefined | null): SidebarVariant {
  return value === "sections" ? "sections" : "classic";
}

/** The `document.cookie` assignment that switches to `variant` (classic = delete the cookie). */
export function sidebarVariantCookie(variant: SidebarVariant): string {
  return variant === "sections"
    ? `${SIDEBAR_VARIANT_COOKIE}=sections; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`
    : `${SIDEBAR_VARIANT_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export interface NavSection {
  label: string;
  icon: typeof Home;
  hrefs: string[];
}

/** The « sections » regrouping: every NAV_GROUPS href exactly once (enforced by tests/lib/sidebar-variant.test.ts). */
export const NAV_SECTIONS: NavSection[] = [
  { label: "Accueil", icon: Home, hrefs: ["/tableau-de-bord", "/documentation"] },
  { label: "Ventes", icon: ShoppingCart, hrefs: ["/operations/nouvelle", "/commandes", "/ventes", "/confirmation", "/clients"] },
  { label: "Livraison & retours", icon: Truck, hrefs: ["/livraison", "/livraison/suivi", "/livraison/retours"] },
  {
    label: "Stock & catalogue",
    icon: Boxes,
    hrefs: ["/produits", "/catalogue/categories", "/stock", "/receptions", "/fournisseurs", "/tracabilite", "/transferts", "/inventaires", "/entrepots"],
  },
  { label: "Finance & pilotage", icon: Wallet, hrefs: ["/rapports", "/analyses", "/finance", "/depenses", "/commissions"] },
  { label: "Système", icon: Settings, hrefs: ["/integrations", "/notifications", "/assistant-ia", "/utilisateurs", "/journal-audit", "/parametres"] },
];

export type SectionedNavGroup = NavGroup & { icon: typeof Home };

/**
 * The « sections » groups for this (effective, channel-scoped) permission set:
 * the very items `visibleNavGroups` allows, regrouped. A NAV_GROUPS item not
 * placed in any section is never dropped — it lands in « Autres ».
 */
export function sectionedNavGroups(permissions: ReadonlySet<Permission>): SectionedNavGroup[] {
  const visible = new Map<string, NavItem>(visibleNavGroups(permissions).flatMap((g) => g.items.map((i) => [i.href, i] as const)));
  const placed = new Set(NAV_SECTIONS.flatMap((s) => s.hrefs));
  const sections: SectionedNavGroup[] = NAV_SECTIONS.map((s) => ({
    label: s.label,
    icon: s.icon,
    items: s.hrefs.flatMap((href) => visible.get(href) ?? []),
  }));
  const others = NAV_GROUPS.flatMap((g) => g.items).filter((i) => !placed.has(i.href) && visible.has(i.href));
  if (others.length > 0) sections.push({ label: "Autres", icon: Layers, items: others });
  return sections.filter((s) => s.items.length > 0);
}
