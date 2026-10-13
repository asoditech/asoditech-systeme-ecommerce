import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { moveMyFavoriteAction, toggleMyFavoriteAction } from "@/actions/favorites";
import { createSession, getCurrentUser } from "@/lib/auth/session";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";

/**
 * « Favoris » storage (User.navFavorites, migration 20261012120000): the
 * session user's OWN list only, NAV_GROUPS hrefs only, visible-only pinning.
 * The pure rules are covered by tests/lib/nav-favorites.test.ts.
 */

const stored = async (id: string) => (await prismaBase.user.findUniqueOrThrow({ where: { id }, select: { navFavorites: true } })).navFavorites;

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("favorites storage", () => {
  it("pin, reorder, unpin — persisted on the user's own row and exposed on the session user", async () => {
    const me = await loginAsTestUser({ role: "MANAGER" });

    expect(await toggleMyFavoriteAction("/commandes")).toEqual({ ok: true, data: { favorites: ["/commandes"] } });
    expect((await toggleMyFavoriteAction("/clients")).ok).toBe(true);
    expect(await stored(me.id)).toEqual(["/commandes", "/clients"]);

    expect(await moveMyFavoriteAction("/clients", -1)).toEqual({ ok: true, data: { favorites: ["/clients", "/commandes"] } });
    expect(await stored(me.id)).toEqual(["/clients", "/commandes"]);
    expect((await getCurrentUser())?.navFavorites).toEqual(["/clients", "/commandes"]);

    expect((await toggleMyFavoriteAction("/clients")).ok).toBe(true);
    expect(await stored(me.id)).toEqual(["/commandes"]);
  });

  it("a page the user may not open cannot be pinned; an arbitrary URL is never stored", async () => {
    const me = await loginAsTestUser({ role: "CONFIRMATION" });
    const refused = await toggleMyFavoriteAction("/finance");
    expect(refused).toMatchObject({ ok: false, error: "Cette page n'est pas disponible pour votre compte." });
    expect((await toggleMyFavoriteAction("https://evil.example/")).ok).toBe(false);
    expect(await stored(me.id)).toEqual([]);
  });

  it("per-user isolation: my actions never touch another user's list (same tenant or another tenant)", async () => {
    const other = await createTestUser({ role: "MANAGER" });
    await prismaBase.user.update({ where: { id: other.id }, data: { navFavorites: ["/stock"] } });
    await prismaBase.tenant.create({ data: { id: "tenant-fav-b", name: "B", slug: "tenant-fav-b" } });
    const foreign = await createTestUser({ role: "MANAGER", tenantId: "tenant-fav-b" });
    await prismaBase.user.update({ where: { id: foreign.id }, data: { navFavorites: ["/clients"] } });

    const me = await loginAsTestUser({ role: "MANAGER" });
    await toggleMyFavoriteAction("/commandes");
    await toggleMyFavoriteAction("/stock");

    expect(await stored(me.id)).toEqual(["/commandes", "/stock"]);
    expect(await stored(other.id)).toEqual(["/stock"]);
    expect(await stored(foreign.id)).toEqual(["/clients"]);
  });

  it("a stored page whose permission was lost stays stored but is not re-pinnable; unpinning it still works", async () => {
    const me = await createTestUser({ role: "CONFIRMATION" });
    // Stored while the user had access (e.g. role changed since).
    await prismaBase.user.update({ where: { id: me.id }, data: { navFavorites: ["/finance", "/commandes"] } });
    await createSession(me.id);

    // Reordering keeps the hidden entry's stored place.
    expect(await moveMyFavoriteAction("/commandes", -1)).toEqual({ ok: true, data: { favorites: ["/commandes", "/finance"] } });
    // Unpinning a hidden page is allowed (it only removes).
    expect(await toggleMyFavoriteAction("/finance")).toEqual({ ok: true, data: { favorites: ["/commandes"] } });
  });

  it("requires a signed-in user", async () => {
    await expect(toggleMyFavoriteAction("/commandes")).rejects.toThrow();
  });
});
