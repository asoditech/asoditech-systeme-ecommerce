"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Secondary nav for the Paramètres area. `Sauvegarde & Portabilité`
 * (docs/adr/0034) is settings.manage-only, so it is only rendered when
 * `canManage`. « Notifications » (docs/adr/0058) is personal and open to
 * every signed-in user — a role without settings.view sees only that tab. */
export function SettingsNav({
  canView = true,
  canManage,
  canManageChannels = false,
}: {
  canView?: boolean;
  canManage: boolean;
  canManageChannels?: boolean;
}) {
  const pathname = usePathname();
  const items = [
    ...(canView ? [{ href: "/parametres", label: "Général" }] : []),
    { href: "/parametres/notifications", label: "Notifications" },
    ...(canView ? [{ href: "/parametres/abonnement", label: "Abonnement & Utilisation" }] : []),
    ...(canManageChannels ? [{ href: "/parametres/canaux", label: "Canaux de vente" }] : []),
    ...(canManage ? [{ href: "/parametres/sauvegarde", label: "Sauvegarde & Portabilité" }] : []),
  ];
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b [scrollbar-width:none]">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
