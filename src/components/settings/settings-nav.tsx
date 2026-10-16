"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ScrollFade } from "@/components/ui/scroll-fade";

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
    ...(canView ? [{ href: "/parametres", label: "Configuration" }] : []),
    { href: "/parametres/notifications", label: "Notifications" },
    ...(canView ? [{ href: "/parametres/abonnement", label: "Abonnement & Utilisation" }] : []),
    ...(canManageChannels ? [{ href: "/parametres/canaux", label: "Canaux de vente" }] : []),
    ...(canManage ? [{ href: "/parametres/sauvegarde", label: "Sauvegarde & Portabilité" }] : []),
  ];
  return (
    <nav aria-label="Sections des paramètres" className="mb-6">
      {/* Scrolls sideways on a phone: the hidden edge fades and the active tab is scrolled into view. */}
      <ScrollFade revealActive className="flex gap-1 border-b border-hairline [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25",
              active
                ? "border-ink text-ink"
                : "border-transparent text-ink-secondary hover:text-ink"
            )}
          >
            {item.label}
          </Link>
        );
      })}
      </ScrollFade>
    </nav>
  );
}
