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
  nav: CustomNav,
  brandBadge,
  homeHref = "/tableau-de-bord",
  showHelp = true,
}: {
  permissions: Set<Permission>;
  favorites?: string[];
  variant?: SidebarVariant;
  /** Optional other navigation (the /platform area) in place of the merchant SidebarNav. */
  nav?: React.ComponentType<{ onNavigate?: () => void }>;
  brandBadge?: React.ReactNode;
  homeHref?: string;
  showHelp?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button type="button" variant="ghost" size="icon" className="size-11 rounded-full hover:bg-nav-hover lg:hidden" aria-label="Ouvrir le menu" />}>
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[288px] flex-col border-0 bg-shell p-0 sm:max-w-[288px]">
        <SheetHeader className="flex-row items-center gap-2.5 px-7 py-5">
          <SheetTitle className="sr-only">Menu de navigation</SheetTitle>
          <Link href={homeHref} onClick={() => setOpen(false)}>
            {/* With a badge, the icon mark keeps the header clear of the close button. */}
            <BrandMark variant={brandBadge ? "icon" : undefined} />
          </Link>
          {brandBadge}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {CustomNav ? (
            <CustomNav onNavigate={() => setOpen(false)} />
          ) : (
            <SidebarNav permissions={permissions} favorites={favorites} variant={variant} onNavigate={() => setOpen(false)} />
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-t border-hairline px-4 py-4">
          {showHelp && (
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
          )}
          <ThemeSegmented />
        </div>
      </SheetContent>
    </Sheet>
  );
}
