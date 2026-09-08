"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Triggers the browser's print dialog (→ "Enregistrer en PDF"). The
 * report pages carry `print:` styles that drop the chrome and lay the
 * tables out for paper. */
export function PrintButton({ label = "Imprimer" }: { label?: string }) {
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => window.print()}>
      <Printer className="size-4" />
      {label}
    </Button>
  );
}
