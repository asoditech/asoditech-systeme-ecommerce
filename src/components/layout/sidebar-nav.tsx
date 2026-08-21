"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/auth/permissions";
import {
  LayoutDashboard,
  ShoppingCart,
  Users,
  Package,
  Boxes,
  Truck,
  LineChart,
  Wallet,
  Megaphone,
  UserCog,
  ScrollText,
  Plug,
  Bell,
  Sparkles,
  Settings,
} from "lucide-react";

const NAV_ITEMS: { href: string; label: string; icon: typeof LayoutDashboard; permission: Permission }[] = [
  { href: "/tableau-de-bord", label: "Tableau de bord", icon: LayoutDashboard, permission: "dashboard.view" },
  { href: "/commandes", label: "Commandes", icon: ShoppingCart, permission: "orders.view" },
  { href: "/clients", label: "Clients", icon: Users, permission: "customers.view" },
  { href: "/produits", label: "Produits", icon: Package, permission: "products.view" },
  { href: "/stock", label: "Stock", icon: Boxes, permission: "inventory.view" },
  { href: "/livraison", label: "Livraison", icon: Truck, permission: "delivery.view" },
  { href: "/analyses", label: "Analyses", icon: LineChart, permission: "analytics.view" },
  { href: "/finance", label: "Finance", icon: Wallet, permission: "finance.view" },
  { href: "/marketing", label: "Marketing", icon: Megaphone, permission: "marketing.view" },
  { href: "/utilisateurs", label: "Utilisateurs", icon: UserCog, permission: "users.view" },
  { href: "/journal-audit", label: "Journal d'audit", icon: ScrollText, permission: "audit.view" },
  { href: "/integrations", label: "Intégrations", icon: Plug, permission: "integrations.view" },
  { href: "/notifications", label: "Notifications", icon: Bell, permission: "dashboard.view" },
  { href: "/assistant-ia", label: "Assistant IA", icon: Sparkles, permission: "ai.use" },
  { href: "/parametres", label: "Paramètres", icon: Settings, permission: "settings.view" },
];

export function SidebarNav({
  orientation = "vertical",
  permissions,
}: {
  orientation?: "vertical" | "horizontal";
  permissions: Set<Permission>;
}) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => permissions.has(item.permission));

  return (
    <nav
      className={cn(
        "gap-0.5 p-2",
        orientation === "vertical" ? "flex flex-col" : "flex flex-row overflow-x-auto"
      )}
    >
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
