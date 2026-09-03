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
  Warehouse,
  ArrowLeftRight,
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

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  permission: Permission;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Aperçu",
    items: [{ href: "/tableau-de-bord", label: "Tableau de bord", icon: LayoutDashboard, permission: "dashboard.view" }],
  },
  {
    label: "Ventes",
    items: [
      { href: "/commandes", label: "Commandes", icon: ShoppingCart, permission: "orders.view" },
      { href: "/clients", label: "Clients", icon: Users, permission: "customers.view" },
      { href: "/livraison", label: "Livraison", icon: Truck, permission: "delivery.view" },
    ],
  },
  {
    label: "Catalogue",
    items: [
      { href: "/produits", label: "Produits", icon: Package, permission: "products.view" },
      { href: "/stock", label: "Stock", icon: Boxes, permission: "inventory.view" },
      { href: "/transferts", label: "Transferts", icon: ArrowLeftRight, permission: "inventory.view" },
      { href: "/entrepots", label: "Emplacements", icon: Warehouse, permission: "inventory.view" },
    ],
  },
  {
    label: "Pilotage",
    items: [
      { href: "/analyses", label: "Analyses", icon: LineChart, permission: "analytics.view" },
      { href: "/finance", label: "Finance", icon: Wallet, permission: "finance.view" },
      { href: "/marketing", label: "Marketing", icon: Megaphone, permission: "marketing.view" },
    ],
  },
  {
    label: "Système",
    items: [
      { href: "/integrations", label: "Intégrations", icon: Plug, permission: "integrations.view" },
      { href: "/notifications", label: "Notifications", icon: Bell, permission: "dashboard.view" },
      { href: "/assistant-ia", label: "Assistant IA", icon: Sparkles, permission: "ai.use" },
      { href: "/utilisateurs", label: "Utilisateurs", icon: UserCog, permission: "users.view" },
      { href: "/journal-audit", label: "Journal d'audit", icon: ScrollText, permission: "audit.view" },
      { href: "/parametres", label: "Paramètres", icon: Settings, permission: "settings.view" },
    ],
  },
];

export function SidebarNav({
  permissions,
  onNavigate,
}: {
  permissions: Set<Permission>;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => permissions.has(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <nav className="flex flex-col gap-4 p-3">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-2.5 pb-1 text-[0.65rem] font-semibold tracking-wider text-sidebar-foreground/45 uppercase">
            {group.label}
          </p>
          {group.items.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-3.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-primary/12 text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                {isActive && (
                  <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-sidebar-primary" />
                )}
                <Icon className={cn("size-4 shrink-0", isActive && "text-sidebar-primary")} />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
