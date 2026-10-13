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

  it("sections: headings per business section, items on a rail, a tinted active row instead of the solid pill", () => {
    const html = render("sections");
    for (const label of ["Ventes", "Stock &amp; catalogue", "Finance &amp; pilotage", "Système"]) expect(html).toContain(label);
    expect(html).toContain('role="group" aria-label="Stock &amp; catalogue"');
    expect(html).toContain("border-l border-sidebar-border");
    const activeLink = (out: string) => out.match(/<a [^>]*href="\/stock"[^>]*>/)?.[0] ?? "";
    expect(activeLink(html)).toContain('aria-current="page"');
    expect(activeLink(html)).toContain("bg-primary/10");
    expect(activeLink(render("classic"))).toContain("bg-primary text-primary-foreground");
  });

  it("the active accent bar sits only on a section rail — never loose in Favoris or the collapsed (rail-less) sidebar", () => {
    const bar = "before:-left-[5px]";
    const activeLink = (out: string, href: string) => out.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))?.[0] ?? "";
    expect(activeLink(render("sections"), "/stock")).toContain(bar);
    expect(activeLink(render("sections", true), "/stock")).toContain('aria-current="page"');
    expect(activeLink(render("sections", true), "/stock")).not.toContain(bar);
    const favActive = renderToStaticMarkup(
      createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: ["/stock"], variant: "sections" })
    );
    const links = [...favActive.matchAll(/<a [^>]*href="\/stock"[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2); // favourite + its section
    expect(links.filter((l) => l.includes(bar))).toHaveLength(1);
  });

  it("a long « Favoris » label stops before its three controls (monter, descendre, retirer); other rows keep the single-star room", () => {
    for (const variant of ["classic", "sections"] as const) {
      const html = renderToStaticMarkup(createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: ["/stock"], variant }));
      const [favorite, regular] = [...html.matchAll(/<a [^>]*href="\/stock"[^>]*>/g)].map((m) => m[0]);
      expect(favorite).toContain("pr-[4.75rem] md:pr-8 md:group-focus-within/nav:pr-[4.75rem] md:group-hover/nav:pr-[4.75rem]");
      expect(regular).not.toContain("4.75rem");
    }
    const collapsed = renderToStaticMarkup(createElement(SidebarNav, { permissions: new Set(PERMISSIONS), favorites: ["/stock"], variant: "classic", collapsed: true }));
    expect(collapsed).not.toContain("4.75rem");
  });

  it("collapsed (icons only) still works in both variants: same links, no headings", () => {
    const sections = render("sections", true);
    expect(hrefsOf(sections)).toEqual(hrefsOf(render("classic", true)));
    // the section name stays only as the group's accessible name; no visible heading
    expect(sections).toContain('aria-label="Stock &amp; catalogue"');
    expect(sections).not.toMatch(/<p(?:\s[^>]*)?>(?:(?!<\/p>).)*Stock &amp; catalogue/);
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
