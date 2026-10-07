import {
  Building2,
  LayoutGrid,
  LifeBuoy,
  PackageCheck,
  ShoppingCart,
  Store,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { ConfigSectionId } from "@/lib/settings/configuration-model";

/**
 * Visual identity of each Configuration section — an icon and one accent,
 * used consistently by the navigation, the overview tiles and the section
 * workspace header so a section is recognisable before its title is read.
 * Accents come from the app's existing palette (primary orange + the
 * standard Tailwind scale used by src/lib/design/tone.ts); amber is kept for
 * "needs attention" only, so no section uses it.
 */

export interface SectionAccent {
  icon: LucideIcon;
  /** Icon chip. */
  chip: string;
  /** Soft gradient wash for a tile/header. */
  wash: string;
  /** Left/top accent bar. */
  bar: string;
  /** Hover/active ring. */
  ring: string;
  /** Same ring on hover only (literal classes, so Tailwind generates them). */
  hoverRing: string;
  /** Accent text (values, links). */
  text: string;
}

export const SECTION_ACCENTS: Record<ConfigSectionId, SectionAccent> = {
  apercu: {
    icon: LayoutGrid,
    chip: "bg-foreground/8 text-foreground",
    wash: "from-foreground/5 via-transparent to-transparent",
    bar: "bg-foreground/60",
    ring: "ring-foreground/15",
    hoverRing: "hover:ring-foreground/15",
    text: "text-foreground",
  },
  entreprise: {
    icon: Building2,
    chip: "bg-primary/12 text-primary",
    wash: "from-primary/12 via-primary/4 to-transparent",
    bar: "bg-primary",
    ring: "ring-primary/30",
    hoverRing: "hover:ring-primary/30",
    text: "text-primary",
  },
  commandes: {
    icon: ShoppingCart,
    chip: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
    wash: "from-sky-500/12 via-sky-500/4 to-transparent",
    bar: "bg-sky-500",
    ring: "ring-sky-500/30",
    hoverRing: "hover:ring-sky-500/30",
    text: "text-sky-600 dark:text-sky-400",
  },
  expedition: {
    icon: PackageCheck,
    chip: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
    wash: "from-emerald-500/12 via-emerald-500/4 to-transparent",
    bar: "bg-emerald-500",
    ring: "ring-emerald-500/30",
    hoverRing: "hover:ring-emerald-500/30",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  magasin: {
    icon: Store,
    chip: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
    wash: "from-violet-500/12 via-violet-500/4 to-transparent",
    bar: "bg-violet-500",
    ring: "ring-violet-500/30",
    hoverRing: "hover:ring-violet-500/30",
    text: "text-violet-600 dark:text-violet-400",
  },
  stock: {
    icon: Warehouse,
    chip: "bg-indigo-500/12 text-indigo-600 dark:text-indigo-400",
    wash: "from-indigo-500/12 via-indigo-500/4 to-transparent",
    bar: "bg-indigo-500",
    ring: "ring-indigo-500/30",
    hoverRing: "hover:ring-indigo-500/30",
    text: "text-indigo-600 dark:text-indigo-400",
  },
  support: {
    icon: LifeBuoy,
    chip: "bg-teal-500/12 text-teal-600 dark:text-teal-400",
    wash: "from-teal-500/12 via-teal-500/4 to-transparent",
    bar: "bg-teal-500",
    ring: "ring-teal-500/30",
    hoverRing: "hover:ring-teal-500/30",
    text: "text-teal-600 dark:text-teal-400",
  },
};
