"use client";

import { useState } from "react";
import Link from "next/link";
import { LifeBuoy, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { BrandMark } from "@/components/brand-mark";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import type { Permission } from "@/lib/auth/permissions";
import type { SidebarVariant } from "@/lib/navigation/sidebar-variant";
import { ThemeSegmented } from "@/components/layout/theme-segmented";
import { openSupportWidget } from "@/lib/support/open-support";

export function MobileNav({
  permissions,
  favorites = [],
  variant = "classic",
}: {
  permissions: Set<Permission>;
  favorites?: string[];
  variant?: SidebarVariant;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button type="button" variant="ghost" size="icon" className="size-11 rounded-full hover:bg-nav-hover lg:hidden" aria-label="Ouvrir le menu" />}>
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[288px] flex-col border-0 bg-shell p-0 sm:max-w-[288px]">
        <SheetHeader className="px-7 py-5">
          <SheetTitle className="sr-only">Menu de navigation</SheetTitle>
          <Link href="/tableau-de-bord" onClick={() => setOpen(false)}>
            <BrandMark />
          </Link>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <SidebarNav permissions={permissions} favorites={favorites} variant={variant} onNavigate={() => setOpen(false)} />
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-t border-hairline px-4 py-4">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSupportWidget();
            }}
            className="flex h-11 items-center gap-3 rounded-control px-3 text-sm font-medium text-ink-secondary transition-colors duration-150 hover:bg-nav-hover hover:text-ink"
          >
            <LifeBuoy className="size-5" aria-hidden="true" />
            Centre d&apos;aide
          </button>
          <ThemeSegmented />
        </div>
      </SheetContent>
    </Sheet>
  );
}
