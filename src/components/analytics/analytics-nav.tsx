import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { canOpenSection, type AnalyticsAccess, type AnalyticsSection } from "@/lib/analytics/access";

const SECTIONS: { key: AnalyticsSection; href: string; label: string }[] = [
  { key: "overview", href: "/analyses", label: "Vue d'ensemble" },
  { key: "confirmation", href: "/analyses/confirmation", label: "Confirmation" },
  { key: "delivery", href: "/analyses/livraison", label: "Livraison" },
  { key: "products", href: "/analyses/produits", label: "Produits" },
  { key: "sources", href: "/analyses/canaux", label: "Origines & magasins" },
  { key: "commissions", href: "/analyses/commissions", label: "Commissions" },
];

/**
 * Section switcher for /analyses (docs/adr/0051). Only the sections the
 * viewer may open are offered — convenience only: every page re-checks
 * `requireSection` server-side. The period is carried across sections.
 */
export function AnalyticsNav({ access, active, query }: { access: AnalyticsAccess; active: AnalyticsSection; query: string }) {
  return (
    <SegmentedControl className="mb-4 print:hidden">
      {SECTIONS.filter((s) => canOpenSection(access, s.key)).map((s) => (
        <SegmentedControlItem key={s.key} active={s.key === active} href={query ? `${s.href}?${query}` : s.href}>
          {s.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
