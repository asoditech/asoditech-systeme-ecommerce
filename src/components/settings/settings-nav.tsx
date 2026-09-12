"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Secondary nav for the Paramètres area. `Sauvegarde & Portabilité`
 * (docs/adr/0034) is settings.manage-only, so it is only rendered when
 * `canManage`. */
export function SettingsNav({ canManage }: { canManage: boolean }) {
  const pathname = usePathname();
  const items = [
    { href: "/parametres", label: "Général" },
    { href: "/parametres/abonnement", label: "Abonnement & Utilisation" },
    ...(canManage ? [{ href: "/parametres/sauvegarde", label: "Sauvegarde & Portabilité" }] : []),
  ];
  return (
    <nav className="mb-6 flex gap-1 border-b">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
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
