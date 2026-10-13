import { describe, expect, it } from "vitest";
import { MAX_FAVORITES, moveFavorite, sanitizeFavorites, toggleFavorite, visibleFavoriteItems } from "@/lib/navigation/favorites";
import { NAV_GROUPS } from "@/lib/navigation/nav-items";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";

/** S8 — favorites rules (pure part; storage: tests/actions/favorites.test.ts). */
const perms = (...p: Permission[]) => new Set<Permission>(p);
const MANAGER = new Set<Permission>(ROLE_PERMISSIONS.MANAGER);
const CONFIRMATION = new Set<Permission>(ROLE_PERMISSIONS.CONFIRMATION);

describe("favorites", () => {
  it("stores only real sidebar destinations, no duplicates, at most 8", () => {
    expect(sanitizeFavorites(["/commandes", "/commandes", "https://evil.example", "/admin/secret", 42, "/clients"])).toEqual(["/commandes", "/clients"]);
    const all = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(sanitizeFavorites(all)).toHaveLength(MAX_FAVORITES);
    expect(MAX_FAVORITES).toBe(8);
  });

  it("pin / unpin: only a page the user can see; the 9th is refused with a clear message", () => {
    expect(toggleFavorite([], "/finance", CONFIRMATION)).toEqual({ ok: false, error: "Cette page n'est pas disponible pour votre compte." });
    expect(toggleFavorite([], "/commandes", CONFIRMATION)).toEqual({ ok: true, favorites: ["/commandes"] });
    expect(toggleFavorite(["/commandes"], "/commandes", CONFIRMATION)).toEqual({ ok: true, favorites: [] });

    const eight = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)).filter((h) => h !== "/clients").slice(0, 8);
    const ninth = toggleFavorite(eight, "/clients", MANAGER);
    expect(ninth.ok).toBe(false);
  });

  it("reorder moves one place, never out of range", () => {
    const list = ["/commandes", "/clients", "/stock"];
    expect(moveFavorite(list, "/stock", -1)).toEqual(["/commandes", "/stock", "/clients"]);
    expect(moveFavorite(list, "/commandes", -1)).toEqual(list);
    expect(moveFavorite(list, "/stock", 1)).toEqual(list);
    expect(moveFavorite(list, "/inconnu", 1)).toEqual(list);
  });

  it("a page the user lost access to is hidden but keeps its stored place", () => {
    const stored = ["/finance", "/commandes"];
    expect(visibleFavoriteItems(stored, MANAGER).map((i) => i.href)).toEqual(["/finance", "/commandes"]);
    expect(visibleFavoriteItems(stored, perms("orders.view")).map((i) => i.href)).toEqual(["/commandes"]);
    expect(sanitizeFavorites(stored)).toEqual(stored); // still stored — back if the permission returns
  });
});
