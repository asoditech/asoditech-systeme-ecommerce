import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * ASODITECH's mark, shared with the Control Center product
 * (public/icon-a.png, public/logo.png) — same company, different product
 * label. `unoptimized`: Next 16's built-in optimizer hard-requires `sharp`
 * with no fallback and 500s here even with it installed — skip it for these
 * small, fixed-size assets rather than chase the optimizer bug.
 */
export function BrandMark({
  variant = "compact",
  className,
}: {
  variant?: "compact" | "full";
  className?: string;
}) {
  if (variant === "full") {
    return (
      <div className={cn("flex flex-col items-center gap-1", className)}>
        <Image
          src="/logo.png"
          alt="ASODITECH"
          width={1418}
          height={280}
          priority
          unoptimized
          className="h-12 w-auto dark:invert"
        />
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Gestion E-commerce
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Image
        src="/icon-a.png"
        alt=""
        width={740}
        height={740}
        priority
        unoptimized
        className="size-6 shrink-0 dark:invert"
      />
      <span className="text-sm font-semibold tracking-tight">ASODITECH E-commerce</span>
    </div>
  );
}
