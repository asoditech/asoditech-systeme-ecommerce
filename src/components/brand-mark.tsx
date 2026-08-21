import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * ASODITECH's mark (public/logos/). Shows the dark-on-light logo in light
 * mode and the light-on-dark logo in dark mode via CSS only (`dark:`
 * variants toggling which one is visible) — no JS/client-side theme read
 * needed, so this stays a Server Component and never flashes the wrong
 * logo, since the `dark` class is already applied to <html> before first
 * paint (see theme-script.tsx). `unoptimized`: Next 16's built-in
 * optimizer hard-requires `sharp` with no fallback and 500s here even
 * with it installed — skip it for these small, fixed-size assets rather
 * than chase the optimizer bug.
 */
export function BrandMark({
  variant = "compact",
  className,
}: {
  variant?: "compact" | "full" | "wordmark";
  className?: string;
}) {
  if (variant === "full") {
    return (
      <div className={cn("flex items-center", className)}>
        <Image
          src="/logos/logo with sub png black.png"
          alt="ASODITECH"
          width={1418}
          height={280}
          priority
          unoptimized
          className="h-9 w-auto dark:hidden"
        />
        <Image
          src="/logos/logo with sub white.png"
          alt="ASODITECH"
          width={1418}
          height={280}
          priority
          unoptimized
          className="hidden h-9 w-auto dark:block"
        />
      </div>
    );
  }

  if (variant === "wordmark") {
    return (
      <div className={cn("flex items-center", className)}>
        <Image
          src="/logos/logo-wordmark-black.png"
          alt="ASODITECH"
          width={1446}
          height={283}
          priority
          unoptimized
          className="h-8 w-auto dark:hidden"
        />
        <Image
          src="/logos/logo white.png"
          alt="ASODITECH"
          width={1204}
          height={216}
          priority
          unoptimized
          className="hidden h-8 w-auto dark:block"
        />
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Image src="/logos/IconA.png" alt="" width={740} height={740} priority unoptimized className="size-7 shrink-0 dark:hidden" />
      <Image src="/logos/Icon white.png" alt="" width={740} height={740} priority unoptimized className="hidden size-7 shrink-0 dark:block" />
      <span className="text-sm font-semibold tracking-tight text-foreground">ASODITECH</span>
    </div>
  );
}
