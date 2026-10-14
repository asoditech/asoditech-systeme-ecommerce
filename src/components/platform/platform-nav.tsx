"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Building2, Gauge, Layers, Megaphone } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/platform", label: "Tenants", icon: Building2 },
  { href: "/platform/plans", label: "Forfaits", icon: Layers },
  { href: "/platform/utilisation", label: "Utilisation", icon: Gauge },
  { href: "/platform/annonces", label: "Annonces", icon: Megaphone },
  { href: "/platform/sante", label: "Santé", icon: Activity },
];

/**
 * « Plateforme » pill beside the logo — the platform-admin identity. Purple
 * (pastel pill pair) so the area can never be mistaken for a merchant space,
 * where the brand stays orange and the active nav pill neutral.
 */
export function PlatformBadge() {
  return (
    <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-pill-purple px-2.5 text-xs font-semibold text-pill-purple-fg">
      Plateforme
    </span>
  );
}

/** Sidebar navigation of /platform (same row metrics as the merchant SidebarNav; active = purple pill + purple rail, readable in both themes). */
export function PlatformNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Navigation plateforme" className={cn("flex flex-col gap-1", collapsed ? "items-center px-3 py-2" : "px-4 py-2")}>
      {ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        const className = cn(
          "relative flex items-center rounded-control text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          collapsed ? "size-11 justify-center" : "h-11 gap-3 px-3",
          active ? "bg-pill-purple text-pill-purple-fg shadow-soft" : "text-ink-secondary hover:bg-nav-hover hover:text-ink"
        );
        const body = (
          <>
            {active && <span aria-hidden="true" className="absolute inset-y-2.5 -left-1.5 w-1 rounded-full bg-pastel-purple" />}
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            {!collapsed && <span className="truncate">{label}</span>}
          </>
        );
        return collapsed ? (
          <Tooltip key={href}>
            <TooltipTrigger render={<Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={label} className={className} />}>
              {body}
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>
              {label}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Link key={href} href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={className}>
            {body}
          </Link>
        );
      })}
    </nav>
  );
}
