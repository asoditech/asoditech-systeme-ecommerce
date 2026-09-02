"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { BrandMark } from "@/components/brand-mark";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import type { Permission } from "@/lib/auth/permissions";

export function MobileNav({ permissions }: { permissions: Set<Permission> }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button type="button" variant="ghost" size="icon" className="md:hidden" aria-label="Ouvrir le menu" />}>
        <Menu className="size-5" />
      </SheetTrigger>
      <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0 sm:max-w-72">
        <SheetHeader className="border-b border-sidebar-border px-4 py-3.5">
          <SheetTitle className="sr-only">Menu de navigation</SheetTitle>
          <Link href="/tableau-de-bord" onClick={() => setOpen(false)}>
            <BrandMark />
          </Link>
        </SheetHeader>
        <div className="overflow-y-auto">
          <SidebarNav permissions={permissions} onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
