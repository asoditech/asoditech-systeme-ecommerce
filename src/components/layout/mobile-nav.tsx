"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { BrandMark } from "@/components/brand-mark";
import { CompanyLogo } from "@/components/layout/company-logo";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import type { Permission } from "@/lib/auth/permissions";
import type { SidebarVariant } from "@/lib/navigation/sidebar-variant";

export function MobileNav({
  permissions,
  favorites = [],
  variant = "classic",
  nav: CustomNav,
  brandBadge,
  homeHref = "/tableau-de-bord",
  companyLogo = null,
}: {
  /** The company's own logo when the platform granted it; null = ASODITECH. */
  companyLogo?: { src: string; companyName: string } | null;
  permissions: Set<Permission>;
  favorites?: string[];
  variant?: SidebarVariant;
  /** Optional other navigation (the /platform area) in place of the merchant SidebarNav. */
  nav?: React.ComponentType<{ onNavigate?: () => void }>;
  brandBadge?: React.ReactNode;
  homeHref?: string;
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
            {companyLogo ? (
              <CompanyLogo src={companyLogo.src} companyName={companyLogo.companyName} fallback={<BrandMark variant={brandBadge ? "icon" : undefined} />} />
            ) : (
              <BrandMark variant={brandBadge ? "icon" : undefined} />
            )}
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
        {/* No « Centre d'aide » / theme block (owner decision 2026-10-16): help is the
            floating button, the theme is the topbar toggle (visible on phones too). */}
      </SheetContent>
    </Sheet>
  );
}
