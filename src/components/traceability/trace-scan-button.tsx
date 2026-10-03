"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { traceabilitySearchHref } from "@/lib/traceability-scan";

/**
 * Camera entry point for Traçabilité: a scanned code runs the page's own
 * search (`?q=`), exactly like typing it into the search field — read-only.
 * The manual field stays next to it and keeps working on its own.
 */
export function TraceScanButton() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  return (
    <BarcodeScanButton
      label="Scanner"
      onDetect={(code) => {
        const href = traceabilitySearchHref(code);
        if (!href) return;
        toast.info(`Recherche du code ${code.trim()}…`);
        startTransition(() => router.push(href));
      }}
    />
  );
}
