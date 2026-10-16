"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import JsBarcode from "jsbarcode";
import { Check, Copy, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CODE128_QUIET_ZONE_MODULES } from "@/lib/catalog/label-layout";

/**
 * Customer code « CL-000001 » as Code 128 (docs/adr/0060). Same rendering as
 * the product label (src/components/products/printable-label.tsx): 1 unit per
 * module + the mandatory quiet zones, stretched by CSS; the human-readable
 * text is HTML, never stretched.
 */
export function CustomerBarcodeSvg({ code, className }: { code: string; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    try {
      JsBarcode(ref.current, code, {
        format: "CODE128",
        width: 1,
        height: 40,
        margin: 0,
        marginLeft: CODE128_QUIET_ZONE_MODULES,
        marginRight: CODE128_QUIET_ZONE_MODULES,
        displayValue: false,
      });
      ref.current.removeAttribute("width");
      ref.current.removeAttribute("height");
      ref.current.setAttribute("preserveAspectRatio", "none");
    } catch {
      // « CL-… » is plain ASCII — always encodable; fail soft regardless.
    }
  }, [code]);
  return <svg ref={ref} role="img" aria-label={`Code-barres ${code}`} data-customer-barcode={code} className={className} />;
}

/** « Code client » block on the customer page: code, barcode, copy, print. */
export function CustomerCodeCard({ customerId, code }: { customerId: string; code: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!code) {
    return (
      <div className="rounded-tile border border-hairline p-4" data-testid="customer-code-card">
        <p className="text-sm font-medium text-ink">Code client</p>
        <p className="mt-1 text-sm text-muted-foreground">Non attribué — les clients créés avant l&apos;activation des codes n&apos;en reçoivent pas automatiquement.</p>
      </div>
    );
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(code!);
      setCopied(true);
      toast.success("Code client copié.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copie impossible dans ce navigateur.");
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-tile border border-hairline p-4" data-testid="customer-code-card">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">Code client</p>
        <p className="font-mono text-lg font-semibold tracking-wide text-ink">{code}</p>
      </div>
      <div className="h-12 w-48 shrink-0 bg-white px-1 py-1">
        <CustomerBarcodeSvg code={code} className="h-full w-full" />
      </div>
      <div className="ml-auto flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy} aria-label="Copier le code client">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          Copier
        </Button>
        <Button variant="outline" size="sm" render={<Link href={`/clients/${customerId}/carte`} />}>
          <Printer className="size-4" />
          Imprimer la carte
        </Button>
      </div>
    </div>
  );
}

/** The printable card itself (85.6 × 54 mm, credit-card size). */
export function PrintableCustomerCard({ name, code, companyName }: { name: string; code: string; companyName: string | null }) {
  return (
    <div
      data-customer-card-sheet
      className="mx-auto flex h-[54mm] w-[85.6mm] flex-col justify-between rounded-xl border border-hairline bg-white p-[4mm] text-black shadow-soft"
    >
      <div>
        {companyName && <p className="truncate text-[8pt] text-neutral-600">{companyName}</p>}
        <p className="truncate text-[12pt] leading-tight font-semibold">{name}</p>
      </div>
      <div>
        <div className="h-[16mm] w-full">
          <CustomerBarcodeSvg code={code} className="h-full w-full" />
        </div>
        <p className="mt-[1mm] text-center font-mono text-[10pt] tracking-widest">{code}</p>
      </div>
    </div>
  );
}

export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      <Printer className="size-4" />
      Imprimer
    </Button>
  );
}
