"use client";

import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

/**
 * The Documentation sidebar (`DocSidebar`) lives in a fixed left column
 * that is `hidden` below `lg` — below that width there was previously NO
 * way at all to move between doc sections/articles except the browser's
 * back button (UI refinement pass, 2026-09). This wraps the SAME
 * server-rendered `<DocSidebar>` (passed as `children`, not re-fetched) in
 * a slide-over so mobile keeps the identical navigation, not a second one.
 */
export function DocMobileNav({ children }: { children: React.ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" size="sm" className="lg:hidden" />}>
        <Menu className="size-4" />
        Sommaire
      </SheetTrigger>
      <SheetContent side="left" className="w-[85vw] max-w-xs gap-3 overflow-y-auto sm:max-w-sm">
        <SheetHeader className="pb-0">
          <SheetTitle>Documentation</SheetTitle>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
