"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { Permission } from "@/lib/auth/permissions";
import {
  LayoutDashboard,
  ShoppingCart,
  PhoneCall,
  Users,
  Package,
  Boxes,
  Warehouse,
  ArrowLeftRight,
  ClipboardCheck,
  Truck,
  Radar,
  LineChart,
  FileBarChart,
  Wallet,
  Receipt,
  HandCoins,
  UserCog,
  ScrollText,
  Plug,
  Bell,
  Sparkles,
  Settings,
  BookOpen,
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

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Aperçu",
    items: [
      { href: "/tableau-de-bord", label: "Tableau de bord", icon: LayoutDashboard, permission: "dashboard.view" },
      { href: "/documentation", label: "Documentation", icon: BookOpen, permission: "dashboard.view" },
    ],
  },
  {
    label: "Ventes",
    items: [
      { href: "/commandes", label: "Commandes", icon: ShoppingCart, permission: "orders.view" },
      { href: "/confirmation", label: "Confirmation", icon: PhoneCall, permission: "orders.confirm" },
      { href: "/clients", label: "Clients", icon: Users, permission: "customers.view" },
      { href: "/livraison", label: "Livraison", icon: Truck, permission: "delivery.view" },
      { href: "/livraison/suivi", label: "Suivi", icon: Radar, permission: "delivery.view" },
    ],
  },
  {
    label: "Catalogue",
    items: [
      { href: "/produits", label: "Produits", icon: Package, permission: "products.view" },
      { href: "/stock", label: "Stock", icon: Boxes, permission: "inventory.view" },
      { href: "/transferts", label: "Transferts", icon: ArrowLeftRight, permission: "inventory.view" },
      { href: "/inventaires", label: "Inventaires", icon: ClipboardCheck, permission: "inventory.view" },
      { href: "/entrepots", label: "Emplacements", icon: Warehouse, permission: "inventory.view" },
    ],
  },
  {
    label: "Pilotage",
    items: [
      { href: "/rapports", label: "Rapports", icon: FileBarChart, permission: "analytics.view" },
      { href: "/analyses", label: "Analyses", icon: LineChart, permission: "analytics.view" },
      { href: "/finance", label: "Finance", icon: Wallet, permission: "finance.view" },
      { href: "/depenses", label: "Dépenses", icon: Receipt, permission: "finance.view" },
      { href: "/commissions", label: "Commissions", icon: HandCoins, permission: "commissions.view" },
      // Marketing is temporarily hidden from navigation (client feedback
      // #9). The route, its `marketing.view` permission and the DB models
      // are all intact — restore this entry to bring the section back.
      // { href: "/marketing", label: "Marketing", icon: Megaphone, permission: "marketing.view" },
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
  collapsed = false,
}: {
  permissions: Set<Permission>;
  onNavigate?: () => void;
  /** Icon-only mode for the desktop sidebar (docs — sidebar collapse
   * toggle). Never passed by `MobileNav`'s drawer — a temporary overlay
   * has no reason to hide its own labels. Purely visual: every href,
   * permission, and active-state rule below is unchanged. */
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  // Every nav href, so a parent (e.g. /livraison) doesn't stay highlighted
  // when a more specific sibling (e.g. /livraison/suivi) is the real match.
  const allHrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => permissions.has(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <nav className="flex flex-col gap-4 p-3">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          {!collapsed && (
            <p className="px-2.5 pb-1 text-[0.65rem] font-semibold tracking-wider text-sidebar-foreground/45 uppercase">
              {group.label}
            </p>
          )}
          {group.items.map((item) => {
            const isActive =
              pathname === item.href ||
              (pathname.startsWith(item.href + "/") &&
                !allHrefs.some(
                  (href) =>
                    href !== item.href &&
                    href.startsWith(item.href + "/") &&
                    (pathname === href || pathname.startsWith(href + "/"))
                ));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md py-1.5 text-sm font-medium transition-colors",
                  collapsed ? "justify-center px-2" : "pr-2.5 pl-3.5",
                  isActive
                    ? "bg-sidebar-primary/12 text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                {isActive && (
                  <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-sidebar-primary" />
                )}
                <Icon className={cn("size-4 shrink-0", isActive && "text-sidebar-primary")} />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
