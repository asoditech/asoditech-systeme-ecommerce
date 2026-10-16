"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The company's own logo in the app shell (only rendered when the platform
 * granted it — see src/lib/branding/shell-logo.ts). Contained in a fixed
 * box so any aspect ratio fits; a broken or unreachable image falls back to
 * `fallback` (the ASODITECH mark) instead of an empty box.
 */
export function CompanyLogo({
  src,
  companyName,
  compact = false,
  fallback,
  className,
}: {
  src: string;
  companyName: string;
  /** Collapsed rail / mobile header: a square box instead of a wide one. */
  compact?: boolean;
  fallback: React.ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    // A plain <img>: the source is the company's own https URL or data URI,
    // which next/image's optimizer can't take without remote config.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={companyName ? `Logo ${companyName}` : "Logo de l'entreprise"}
      onError={() => setFailed(true)}
      // Dark theme: a light chip behind the logo — company logos are usually
      // drawn for a light background and vanish on the dark sidebar.
      className={cn("shrink-0 object-contain dark:rounded-md dark:bg-white dark:p-0.5", compact ? "size-8" : "h-9 max-w-[180px]", className)}
    />
  );
}
