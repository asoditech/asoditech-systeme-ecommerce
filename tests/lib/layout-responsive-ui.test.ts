import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/parametres/notifications",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: () => {
    throw new Error("redirect");
  },
}));

import { horizontalOverflow, scrollFadeMask, scrollLeftToReveal, ScrollFade, SCROLL_FADE_PX } from "@/components/ui/scroll-fade";
import { Table, TableBody, TableCard, TableCell, TableRow } from "@/components/ui/table";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { SettingsNav } from "@/components/settings/settings-nav";
import { OrderLifecycleStepper } from "@/components/orders/order-lifecycle-stepper";
import { FilterSelect } from "@/components/filter-select";

/**
 * Layout regressions (1440px / 390px audit): discoverable horizontal scroll
 * on tables and tab rows, the order stepper on phones, the help button vs
 * the content bottom, select trigger widths, the dev indicator.
 */

type ItemProps = Parameters<typeof SegmentedControlItem>[0];

const ROOT = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("horizontalOverflow", () => {
  it("reports nothing when the content fits (incl. 1px sub-pixel rounding)", () => {
    expect(horizontalOverflow(0, 500, 500)).toEqual({ start: false, end: false });
    expect(horizontalOverflow(0, 501, 500)).toEqual({ start: false, end: false });
  });
  it("hides the end at the start, both in the middle, the start at the end", () => {
    expect(horizontalOverflow(0, 900, 500)).toEqual({ start: false, end: true });
    expect(horizontalOverflow(200, 900, 500)).toEqual({ start: true, end: true });
    expect(horizontalOverflow(400, 900, 500)).toEqual({ start: true, end: false });
  });
  it("handles RTL scrollers (negative scrollLeft)", () => {
    expect(horizontalOverflow(-400, 900, 500)).toEqual({ start: true, end: false });
  });
});

describe("scrollFadeMask", () => {
  it("is absent when nothing is hidden, and fades only the hidden edge(s)", () => {
    expect(scrollFadeMask({ start: false, end: false })).toBeUndefined();
    expect(scrollFadeMask({ start: false, end: true })).toBe(
      `linear-gradient(to right, transparent 0, #000 0px, #000 calc(100% - ${SCROLL_FADE_PX}px), transparent 100%)`
    );
    expect(scrollFadeMask({ start: true, end: false })).toContain(`#000 ${SCROLL_FADE_PX}px, #000 calc(100% - 0px)`);
  });
});

describe("scrollLeftToReveal", () => {
  const view = { scrollLeft: 0, clientWidth: 300 };
  it("returns null when the child is already fully visible", () => {
    expect(scrollLeftToReveal(view, { offsetLeft: 40, offsetWidth: 100 })).toBeNull();
  });
  it("scrolls right just enough to show a child past the right edge (plus the fade margin)", () => {
    expect(scrollLeftToReveal(view, { offsetLeft: 500, offsetWidth: 100 })).toBe(500 + 100 + SCROLL_FADE_PX - 300);
  });
  it("scrolls left to a child before the visible area, never below 0", () => {
    expect(scrollLeftToReveal({ scrollLeft: 400, clientWidth: 300 }, { offsetLeft: 100, offsetWidth: 80 })).toBe(100 - SCROLL_FADE_PX);
    expect(scrollLeftToReveal({ scrollLeft: 400, clientWidth: 300 }, { offsetLeft: 10, offsetWidth: 80 })).toBe(0);
  });
});

describe("ScrollFade / Table container", () => {
  it("is a plain horizontal scroller until it overflows (no empty tab stop, no mask)", () => {
    const html = renderToStaticMarkup(createElement(ScrollFade, { label: "Zone" }, "x"));
    expect(html).toContain("overflow-x-auto");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("mask-image");
  });
  it("Table keeps data-slot=table-container as TableCard's direct child (Suivi's sticky selector)", () => {
    const html = renderToStaticMarkup(
      createElement(TableCard, null, createElement(Table, null, createElement(TableBody, null, createElement(TableRow, null, createElement(TableCell, null, "a")))))
    );
    expect(html).toMatch(/^<div data-slot="table-card"[^>]*><div [^>]*data-slot="table-container"/);
    expect(html).toContain('data-slot="table"');
  });
});

describe("section tabs (/analyses, /parametres) never hide choices silently", () => {
  it("SegmentedControl scrolls inside a fading scroller and keeps every item", () => {
    const html = renderToStaticMarkup(
      createElement(
        SegmentedControl,
        null,
        createElement(SegmentedControlItem, { active: false, href: "/a" } as ItemProps, "A"),
        createElement(SegmentedControlItem, { active: true, href: "/b" } as ItemProps, "B")
      )
    );
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('aria-current="true"');
    expect(html.match(/<a /g)).toHaveLength(2);
  });
  it("SettingsNav marks the current tab (aria-current) so it can be scrolled into view", () => {
    const html = renderToStaticMarkup(createElement(SettingsNav, { canManage: true, canManageChannels: true }));
    expect(html).toContain('aria-label="Sections des paramètres"');
    expect(html).toMatch(/<a [^>]*href="\/parametres\/notifications"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/parametres\/notifications"/);
    expect(html).toContain("overflow-x-auto");
    for (const label of ["Configuration", "Notifications", "Abonnement", "Canaux de vente", "Sauvegarde"]) expect(html).toContain(label);
  });
  it("ConfigNav (Paramètres sections) uses the same fading scroller", () => {
    const code = src("src/components/settings/config/config-blocks.tsx");
    expect(code).toMatch(/<ScrollFade revealActive[^>]*>\s*<ul className="flex w-max gap-1">/);
  });
});

describe("order lifecycle stepper on phones", () => {
  const base = {
    placedAt: new Date("2026-10-12"),
    confirmedAt: new Date("2026-10-12"),
    shippedAt: new Date("2026-10-12"),
    deliveredAt: new Date("2026-10-13"),
    cancelledAt: null,
    commissionStatus: "none" as const,
  };
  it("is a vertical list below sm (every step visible), horizontal from sm", () => {
    const html = renderToStaticMarkup(createElement(OrderLifecycleStepper, { ...base, status: "RETOUR" }));
    expect(html).toContain('<ol data-slot="order-lifecycle" aria-label="Étapes de la commande" class="flex flex-col sm:flex-row sm:items-start"');
    expect(html.match(/<li /g)).toHaveLength(5);
    // Vertical connector on phones, horizontal bar from sm.
    expect(html).toContain("absolute top-5 bottom-1 left-[5px] w-0.5");
    expect(html).toContain("sm:static sm:mt-[5px] sm:h-0.5");
    // The current step is announced.
    expect(html).toMatch(/<li aria-current="step"[^>]*>(?:(?!<li).)*Retour/);
  });
});

describe("FilterSelect trigger width", () => {
  it("grows to fit its label on phones (min half a row) and carries the full label as title", () => {
    const html = renderToStaticMarkup(
      createElement(FilterSelect, {
        paramKey: "source",
        allLabel: "Toutes les sources de coût",
        options: [{ value: "a", label: "A" }],
        className: "w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-52",
      })
    );
    expect(html).toContain('title="Toutes les sources de coût"');
    expect(html).toContain("max-sm:w-auto");
    expect(html).toContain("max-sm:grow");
    expect(html).toContain("max-sm:min-w-[calc(50%-0.25rem)]");
  });
  it("report filters size to their label instead of a fixed w-52", () => {
    for (const f of ["report-online-channel-filter", "report-store-filter", "warehouse-picker-link"]) {
      const code = src(`src/components/reports/${f}.tsx`);
      expect(code).toContain("w-auto max-w-full min-w-52");
      expect(code).not.toMatch(/className="(h-8 )?w-52"/);
    }
  });
  it("the client picker popover is at least the trigger width, ≥ 22rem, ≤ viewport", () => {
    const code = src("src/components/orders/order-form.tsx");
    expect(code).toContain('className="w-(--anchor-width) max-w-[calc(100vw-2rem)] min-w-[min(22rem,calc(100vw-2rem))] p-2"');
  });
});

describe("help button (« Centre d'aide ») vs content", () => {
  it("is positioned with the safe-area insets and steps aside for the unsaved-changes bar", () => {
    const code = src("src/components/support/support-widget.tsx");
    expect(code).toContain("bottom-[calc(3rem+env(safe-area-inset-bottom))]");
    expect(code).toContain("right-[calc(1rem+env(safe-area-inset-right))]");
    expect(code).toContain("[body:has(form[data-state=dirty])_&]:hidden");
  });
  it("the content column reserves the FAB height + safe area on phones", () => {
    expect(src("src/components/layout/app-shell.tsx")).toContain("pb-[calc(6rem+env(safe-area-inset-bottom))]");
  });
});

describe("list tables fit at 1440px", () => {
  it("/commandes: Canal is a 2xl column, folded into the order's second line below", () => {
    const code = src("src/app/(protected)/commandes/page.tsx");
    expect(code).toContain('<TableHead className="hidden 2xl:table-cell">Canal</TableHead>');
    expect(code).toContain('<span className="2xl:hidden"> · {displayOrderChannel(o)}</span>');
  });
  it("/livraison/retours: location and units are 2xl columns, folded into other cells below", () => {
    const code = src("src/components/returns/return-parcels-table.tsx");
    expect(code).toContain('className="hidden 2xl:table-cell">Emplacement');
    expect(code).toContain('<div className="text-xs text-muted-foreground 2xl:hidden">{p.warehouseName ?? "—"}</div>');
    expect(code).toMatch(/2xl:hidden">\s*\{p\.returnedUnits\} \/ \{p\.shippedUnits\} unité/);
  });
});

describe("Next.js dev indicator", () => {
  it("is turned off (dev only; compile/runtime errors still surface)", async () => {
    const { default: config } = await import("../../next.config");
    expect(config.devIndicators).toBe(false);
  });
});
