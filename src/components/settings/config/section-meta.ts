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
 * Soft UI: accents are the pastel pill pairs of globals.css (AA in light
 * and dark); yellow is kept for "needs attention" only, so no section uses it.
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
    chip: "bg-pill-neutral text-ink",
    wash: "from-pill-neutral via-transparent to-transparent",
    bar: "bg-ink-faint",
    ring: "ring-hairline",
    hoverRing: "hover:ring-hairline",
    text: "text-ink",
  },
  entreprise: {
    icon: Building2,
    chip: "bg-pill-peach text-pill-peach-fg",
    wash: "from-pill-peach/70 via-transparent to-transparent",
    bar: "bg-pastel-peach",
    ring: "ring-pastel-peach",
    hoverRing: "hover:ring-pastel-peach",
    text: "text-pill-peach-fg",
  },
  commandes: {
    icon: ShoppingCart,
    chip: "bg-pill-blue text-pill-blue-fg",
    wash: "from-pill-blue/70 via-transparent to-transparent",
    bar: "bg-pastel-blue",
    ring: "ring-pastel-blue",
    hoverRing: "hover:ring-pastel-blue",
    text: "text-pill-blue-fg",
  },
  expedition: {
    icon: PackageCheck,
    chip: "bg-pill-green text-pill-green-fg",
    wash: "from-pill-green/70 via-transparent to-transparent",
    bar: "bg-pastel-green",
    ring: "ring-pastel-green",
    hoverRing: "hover:ring-pastel-green",
    text: "text-pill-green-fg",
  },
  magasin: {
    icon: Store,
    chip: "bg-pill-purple text-pill-purple-fg",
    wash: "from-pill-purple/70 via-transparent to-transparent",
    bar: "bg-pastel-purple",
    ring: "ring-pastel-purple",
    hoverRing: "hover:ring-pastel-purple",
    text: "text-pill-purple-fg",
  },
  stock: {
    icon: Warehouse,
    chip: "bg-pill-blue text-pill-blue-fg",
    wash: "from-pill-blue/70 via-transparent to-transparent",
    bar: "bg-pastel-blue",
    ring: "ring-pastel-blue",
    hoverRing: "hover:ring-pastel-blue",
    text: "text-pill-blue-fg",
  },
  support: {
    icon: LifeBuoy,
    chip: "bg-pill-green text-pill-green-fg",
    wash: "from-pill-green/70 via-transparent to-transparent",
    bar: "bg-pastel-green",
    ring: "ring-pastel-green",
    hoverRing: "hover:ring-pastel-green",
    text: "text-pill-green-fg",
  },
};
