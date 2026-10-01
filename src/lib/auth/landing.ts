import { userHasPermission, type Permission } from "@/lib/auth/permissions";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Where a signed-in user lands (docs/adr/0050 — G8). Every post-login /
 * acceptance redirect targets `/tableau-de-bord`; the dashboard itself now
 * requires `dashboard.view` and forwards anyone without it to the first page
 * their effective access really opens — never into a dead end. Each entry
 * mirrors that page's own server guard (permission + channel kind).
 */
const LANDINGS: { path: string; permission: Permission; channel?: "online" | "offline" }[] = [
  { path: "/tableau-de-bord", permission: "dashboard.view" },
  { path: "/commandes", permission: "orders.view" },
  { path: "/confirmation", permission: "orders.confirm" },
  { path: "/ventes", permission: "sales.view", channel: "offline" },
  { path: "/stock", permission: "inventory.view" },
  { path: "/produits", permission: "products.view" },
  { path: "/receptions", permission: "purchases.view" },
  { path: "/livraison", permission: "delivery.view" },
  { path: "/clients", permission: "customers.view" },
  { path: "/finance", permission: "finance.view", channel: "online" },
  { path: "/rapports", permission: "analytics.view" },
  { path: "/utilisateurs", permission: "users.view" },
];

export function landingPathFor(user: Pick<CurrentUser, "permissions" | "channels">): string {
  const hit = LANDINGS.find((l) => userHasPermission(user, l.permission) && (!l.channel || user.channels[l.channel]));
  return hit?.path ?? "/acces-refuse";
}
