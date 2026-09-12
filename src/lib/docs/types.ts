import type { Permission } from "@/lib/auth/permissions";
import type { UserRole } from "@prisma/client";

/**
 * The Documentation/Demo Center's content model — see docs/CONTRIBUTING.md.
 * Content is plain typed data (no MDX/CMS), rendered by the shared
 * components in src/components/docs/. Every fact in an article body must
 * trace back to real code (a route, a permission, an actual thrown/shown
 * message) — never invented behavior.
 */

export type DocCategoryId =
  | "bien-demarrer"
  | "integrations"
  | "produits"
  | "clients"
  | "commandes"
  | "stock"
  | "confirmation"
  | "livraison"
  | "finance"
  | "rapports"
  | "utilisateurs"
  | "sauvegarde"
  | "parametres"
  | "abonnement"
  | "troubleshooting";

export type CalloutTone = "info" | "warning" | "success" | "danger";

export type DocBlock =
  | { type: "p"; text: string }
  | { type: "callout"; tone: CalloutTone; title?: string; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; code: string; lang?: string }
  | { type: "table"; headers: string[]; rows: string[][] };

export interface TroubleshootingEntry {
  /** The user-facing symptom, in the words a non-technical user would use. */
  symptom: string;
  cause: string;
  check: string;
  solution: string;
  expectedResult: string;
  /** Verbatim error/UI strings this entry documents — quoted exactly from the code, never paraphrased, so search can match them. Omit rather than invent. */
  errorStrings?: string[];
}

export interface DocArticle {
  /** Unique across the whole registry, e.g. "livraison/creer-une-expedition". */
  slug: string;
  title: string;
  category: DocCategoryId;
  /** "À quoi ça sert ?" — one or two sentences. */
  tagline: string;
  /** Roles for which this article is especially relevant (affects sort order only — every article is readable by every logged-in user). Omit = relevant to all. */
  roles?: UserRole[];
  /** The permission the *action* described requires. Gates the "Essayer maintenant" link — never gates reading the article itself. */
  permission?: Permission;
  prerequisites?: string[];
  steps?: string[];
  whatYouShouldSee?: string;
  commonMistakes?: string[];
  troubleshooting?: TroubleshootingEntry[];
  /** Slugs of related articles — validated to resolve by tests/lib/docs-registry.test.ts. */
  related?: string[];
  /** Deep link to the real corresponding page — the "Essayer maintenant" target. Also what tests/lib/docs-coverage.test.ts matches against NAV_GROUPS. */
  tryNow?: { label: string; href: string };
  /** Extra free-form content beyond the fixed fields above. */
  body?: DocBlock[];
  /** Search-only synonyms/phrases (French, common user questions, error text) — never rendered. */
  keywords?: string[];
  lastUpdated: string;
}

export interface GuidedTourStep {
  label: string;
  description: string;
  href?: string;
}

export interface GuidedTour {
  slug: string;
  title: string;
  tagline: string;
  roles?: UserRole[];
  steps: GuidedTourStep[];
}

export interface RolePath {
  role: UserRole;
  title: string;
  slugs: string[];
}
