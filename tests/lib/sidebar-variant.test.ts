import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import { NAV_GROUPS, visibleNavGroups } from "@/lib/navigation/nav-items";
import { sanitizeFavorites } from "@/lib/navigation/favorites";
import {
  NAV_SECTIONS,
  parseSidebarVariant,
  sectionedNavGroups,
  sidebarVariantCookie,
  SIDEBAR_VARIANT_COOKIE,
} from "@/lib/navigation/sidebar-variant";

vi.mock("next/navigation", () => ({
  usePathname: () => "/stock",
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
const { SidebarNav } = await import("@/components/layout/sidebar-nav");

/**
 * Sidebar presentation experiment: « sections » is the same navigation as
 * « classic » (NAV_GROUPS) regrouped — same links, labels, icons and
 * permission filtering — chosen by a per-browser cookie, classic by default.
 */

const allHrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
const flat = (groups: { items: { href: string }[] }[]) => groups.flatMap((g) => g.items);
const permissionSets: [string, Set<Permission>][] = [
  ["every permission", new Set(PERMISSIONS)],
  ...Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, new Set(perms)] as [string, Set<Permission>]),
  ["online-only manager (no OFFLINE domain)", new Set(ROLE_PERMISSIONS.MANAGER.filter((p) => p !== "sales.view" && p !== "sales.create"))],
  ["nothing", new Set<Permission>()],
];

describe("one navigation, two presentations", () => {
  it("the sections hold every NAV_GROUPS link exactly once (no duplicate, nothing missing or invented)", () => {
    const sectionHrefs = NAV_SECTIONS.flatMap((s) => s.hrefs);
    expect(new Set(sectionHrefs).size).toBe(sectionHrefs.length);
    expect([...sectionHrefs].sort()).toEqual([...allHrefs].sort());
    for (const href of sectionHrefs) expect(sanitizeFavorites([href]), href).toEqual([href]); // still a valid favourite
  });

  it.each(permissionSets)("for %s: exactly the items the classic sidebar allows — same objects (link, label, icon, permission)", (_, permissions) => {
    const classic = flat(visibleNavGroups(permissions));
    const sections = flat(sectionedNavGroups(permissions));
    expect(sections).toHaveLength(classic.length);
    expect(new Set(sections)).toEqual(new Set(classic)); // identity: the very NAV_GROUPS item objects
  });

  it("groups by business section: sales, delivery, stock, finance, system", () => {
    const labels = sectionedNavGroups(new Set(PERMISSIONS)).map((g) => g.label);
    expect(labels).toEqual(["Accueil", "Ventes", "Livraison & retours", "Stock & catalogue", "Finance & pilotage", "Système"]);
  });

  it("NAV_GROUPS itself is untouched (global search and favourites read it)", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(["Aperçu", "Ventes", "Catalogue", "Pilotage", "Système"]);
    const search = readFileSync(join(process.cwd(), "src/actions/search.ts"), "utf8");
    expect(search).toContain("visibleNavGroups");
    expect(search).not.toContain("sectionedNavGroups");
  });
});

describe("rendered sidebar", () => {
  const render = (variant?: "classic" | "sections", collapsed = false) =>
    renderToStaticMarkup(
      createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: ["/commandes", "/finance"], collapsed, variant })
    );
  const hrefsOf = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]).sort();

  it("defaults to the current (classic) sidebar", () => {
    expect(render()).toBe(render("classic"));
    expect(render()).toContain('data-sidebar-variant="classic"');
  });

  it("both variants render the same links (favourites included) and the same pin buttons", () => {
    const classic = render("classic");
    const sections = render("sections");
    expect(hrefsOf(sections)).toEqual(hrefsOf(classic));
    const pins = (html: string) => [...html.matchAll(/aria-label="((?:Ajouter|Retirer) « [^»]+ » (?:aux|des) favoris)"/g)].map((m) => m[1]).sort();
    expect(pins(sections)).toEqual(pins(classic));
    expect(sections).toContain('aria-label="Favoris"');
  });

  it("Soft UI: the active row is the neutral grey pill in both variants — never the orange", () => {
    const activeLink = (out: string) => out.match(/<a [^>]*href="\/stock"[^>]*>/)?.[0] ?? "";
    for (const variant of ["classic", "sections"] as const) {
      const link = activeLink(render(variant));
      expect(link).toContain('aria-current="page"');
      expect(link).toContain("bg-nav-active");
      expect(link).not.toMatch(/bg-primary|bg-brand/);
    }
  });

  it("sections: one row per business section; its items hang off a tree with connectors; only the current page's section is open", () => {
    const html = render("sections");
    for (const label of ["Ventes", "Stock &amp; catalogue", "Finance &amp; pilotage", "Système"]) expect(html).toContain(label);
    expect(html).toContain('role="group" aria-label="Stock &amp; catalogue"');
    expect(html).toContain("data-nav-tree-item");
    expect(html).toContain("before:rounded-bl-[10px]");
    const expanded = [...html.matchAll(/aria-expanded="(true|false)"/g)].map((m) => m[1]);
    expect(expanded.filter((v) => v === "true")).toHaveLength(1); // « Stock & catalogue » (the test pathname is /stock)
    // a closed section stays out of the tab order
    expect(html).toMatch(/data-open="false" inert=""/);
  });

  it("classic: sentence-case section labels that fold (all open by default) — no uppercase labels, no tree", () => {
    const html = render("classic");
    expect(html).not.toContain("uppercase");
    expect(html).not.toContain("data-nav-tree-item");
    const expanded = [...html.matchAll(/aria-expanded="(true|false)"/g)].map((m) => m[1]);
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded.every((v) => v === "true")).toBe(true);
  });

  it("a long « Favoris » label stops before its three controls (monter, descendre, retirer); other rows keep the single-star room", () => {
    for (const variant of ["classic", "sections"] as const) {
      const html = renderToStaticMarkup(createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: ["/stock"], variant }));
      const [favorite, regular] = [...html.matchAll(/<a [^>]*href="\/stock"[^>]*>/g)].map((m) => m[0]);
      expect(favorite).toContain("pr-[4.75rem] md:pr-9 md:group-focus-within/nav:pr-[4.75rem] md:group-hover/nav:pr-[4.75rem]");
      expect(regular).not.toContain("4.75rem");
    }
    const collapsed = renderToStaticMarkup(createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: ["/stock"], variant: "classic", collapsed: true }));
    expect(collapsed).not.toContain("4.75rem");
  });

  it("collapsed rail: classic keeps every link as a labelled icon; « sections » is one labelled trigger per section (its links open in a floating card); no visible headings", () => {
    const classic = render("classic", true);
    expect(hrefsOf(classic)).toEqual(hrefsOf(render("classic")));
    expect(classic).toContain('aria-label="Commandes"');

    const sections = render("sections", true);
    for (const label of ["Ventes", "Stock &amp; catalogue", "Système"]) {
      expect(sections).toContain(`role="group" aria-label="${label}"`);
      expect(sections).toMatch(new RegExp(`<button[^>]*aria-label="${label}"`));
    }
    expect(sections).not.toContain("data-nav-tree-item");
    expect(sections).not.toMatch(/<p(?:\s[^>]*)?>(?:(?!<\/p>).)*Stock &amp; catalogue/);
  });

  it("NavBadge slot: a count shows a pastel chip on its row; none without data (not wired)", () => {
    const withCount = renderToStaticMarkup(
      createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: [], variant: "classic", badges: { "/commandes": 7 } })
    );
    expect(withCount).toContain('data-slot="nav-badge"');
    expect(withCount).toMatch(/data-slot="nav-badge"[^>]*>7</);
    expect(render("classic")).not.toContain('data-slot="nav-badge"');
  });
});

describe("switch: a per-browser cookie, classic unless explicitly opted in", () => {
  it("only « sections » enables the experiment", () => {
    expect(parseSidebarVariant(undefined)).toBe("classic");
    expect(parseSidebarVariant("")).toBe("classic");
    expect(parseSidebarVariant("v2")).toBe("classic");
    expect(parseSidebarVariant("sections")).toBe("sections");
  });

  it("on = a one-year cookie; off = the cookie is deleted (back to the default)", () => {
    expect(sidebarVariantCookie("sections")).toBe(`${SIDEBAR_VARIANT_COOKIE}=sections; path=/; max-age=31536000; samesite=lax`);
    expect(sidebarVariantCookie("classic")).toBe(`${SIDEBAR_VARIANT_COOKIE}=; path=/; max-age=0; samesite=lax`);
  });

  it("the toggle writes the cookie and refreshes — no server action, nothing stored on the account or company", () => {
    const menu = readFileSync(join(process.cwd(), "src/components/layout/user-menu.tsx"), "utf8");
    const toggle = menu.slice(menu.indexOf("function switchSidebar"), menu.indexOf("return (", menu.indexOf("function switchSidebar")));
    expect(toggle).toContain("document.cookie = sidebarVariantCookie(");
    expect(toggle).toContain("router.refresh()");
    expect(toggle).not.toMatch(/Action\(/);
    const shell = readFileSync(join(process.cwd(), "src/components/layout/app-shell.tsx"), "utf8");
    expect(shell).toContain("parseSidebarVariant(cookieStore.get(SIDEBAR_VARIANT_COOKIE)?.value)");
  });
});
