"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellRing, ChevronDown, LayoutList, LogOut, User as UserIcon } from "lucide-react";
import { logoutAction } from "@/actions/auth";
import { sidebarVariantCookie, type SidebarVariant } from "@/lib/navigation/sidebar-variant";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

/**
 * Header user menu — avatar, name, role, « Mes notifications » (Paramètres → Notifications, open to every role),
 * the sidebar presentation switch (a per-browser cookie only — src/lib/navigation/sidebar-variant.ts), and the
 * sign-out action (moved here from the sidebar).
 */
export function UserMenu({ name, role, sidebarVariant = "classic" }: { name: string; role: string; sidebarVariant?: SidebarVariant }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function switchSidebar() {
    // Presentation preference of this browser only: no server call, nothing stored on the account or the company.
    document.cookie = sidebarVariantCookie(sidebarVariant === "sections" ? "classic" : "sections");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" className="h-11 gap-2 rounded-full p-0.5 hover:bg-nav-hover lg:pr-3" />}>
        <Avatar size="lg">
          <AvatarFallback className="bg-pill-peach text-sm font-semibold text-pill-peach-fg">
            {initials(name) || <UserIcon className="size-4" />}
          </AvatarFallback>
        </Avatar>
        <span className="hidden max-w-32 truncate text-sm font-medium text-ink lg:inline">{name}</span>
        <ChevronDown className="hidden size-4 text-ink-faint lg:inline" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <p className="truncate font-medium">{name}</p>
            <p className="truncate text-xs font-normal text-muted-foreground">{role}</p>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/parametres/notifications" />}>
          <BellRing className="size-4" />
          Mes notifications
        </DropdownMenuItem>
        <DropdownMenuItem onClick={switchSidebar} data-sidebar-variant-toggle="">
          <LayoutList className="size-4" />
          {sidebarVariant === "sections" ? "Revenir au menu actuel" : "Essayer le nouveau menu"}
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={isPending}
          onClick={() => startTransition(() => void logoutAction())}
        >
          <LogOut className="size-4" />
          Se déconnecter
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
