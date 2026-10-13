"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUserForAction } from "@/lib/auth/guards";
import { moveFavorite, sanitizeFavorites, toggleFavorite } from "@/lib/navigation/favorites";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * « Favoris » (S8) — the session user's OWN pinned sidebar pages. There is no
 * userId parameter: every action reads and writes `where: { id: user.id }`
 * only, so nobody can change another user's list. Only NAV_GROUPS hrefs are
 * ever stored (sanitizeFavorites); pinning requires that the user can see the
 * page now (toggleFavorite), and a favorite never grants access — each page
 * still checks its own permission on the server.
 */

async function loadOwnFavorites(userId: string): Promise<string[]> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { navFavorites: true } });
  return row.navFavorites;
}

async function saveOwnFavorites(userId: string, favorites: string[]) {
  await prisma.user.update({ where: { id: userId }, data: { navFavorites: sanitizeFavorites(favorites) } });
  // The sidebar is rendered by the protected layout on every page.
  revalidatePath("/", "layout");
}

export async function toggleMyFavoriteAction(href: string): Promise<ActionResult<{ favorites: string[] }>> {
  const user = await requireUserForAction();
  if (typeof href !== "string") return actionError("Page inconnue.");
  const result = toggleFavorite(await loadOwnFavorites(user.id), href, new Set(user.permissions));
  if (!result.ok) return actionError(result.error);
  await saveOwnFavorites(user.id, result.favorites);
  return actionOk({ favorites: result.favorites });
}

export async function moveMyFavoriteAction(href: string, direction: -1 | 1): Promise<ActionResult<{ favorites: string[] }>> {
  const user = await requireUserForAction();
  if (typeof href !== "string" || (direction !== -1 && direction !== 1)) return actionError("Déplacement invalide.");
  const favorites = moveFavorite(await loadOwnFavorites(user.id), href, direction);
  await saveOwnFavorites(user.id, favorites);
  return actionOk({ favorites });
}
