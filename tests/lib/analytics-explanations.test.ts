import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_METRIC_IDS,
  ANALYTICS_METRICS,
  SECTION_ORDER,
  metricsForSection,
  type AnalyticsMetricId,
} from "@/lib/metrics/analytics-explanations";
import { EXAMPLE, EXAMPLE_ATTEMPTS_TOTAL, EXAMPLE_DURATIONS, EXAMPLE_ORDERS, EXAMPLE_STORE, orderTotal } from "@/lib/metrics/example-dataset";
import { durationOf } from "@/lib/analytics/queries/online";
import { formatHours } from "@/lib/analytics/format";
import { MetricExplanationBody } from "@/components/analytics/metric-explanation";
import { KpiCard } from "@/components/kpi-card";
import { setExplanationLanguage } from "@/components/analytics/explanation-language";
import type { AnalyticsSection } from "@/lib/analytics/access";

/**
 * Analytics explanations (Analyses & Rapports transparency): every figure
 * shown under /analyses has an explanation in French AND Arabic, the
 * examples agree with the code's own formulas, Arabic is RTL only inside the
 * explanation, and the language can never reach a query or the page chrome.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PAGES: Record<AnalyticsSection, string> = {
  overview: "src/app/(protected)/analyses/page.tsx",
  confirmation: "src/app/(protected)/analyses/confirmation/page.tsx",
  delivery: "src/app/(protected)/analyses/livraison/page.tsx",
  products: "src/app/(protected)/analyses/produits/page.tsx",
  sources: "src/app/(protected)/analyses/canaux/page.tsx",
  commissions: "src/app/(protected)/analyses/commissions/page.tsx",
};
const PRODUCT_TABLE = "src/components/analytics/product-performance-table.tsx";
const ARABIC = /[؀-ۿ]/;
const decode = (s: string) => s.replace(/&apos;/g, "'");

/** Every `<KpiCard …/>` of a page source: its label and metric props. */
function kpiCards(src: string) {
  return [...src.matchAll(/<KpiCard\b([\s\S]*?)\/>/g)].map((m) => ({
    label: m[1].match(/\blabel="([^"]+)"/)?.[1] ?? null,
    metric: m[1].match(/\bmetric="([^"]+)"/)?.[1] ?? null,
  }));
}

describe("every displayed figure has a registered explanation", () => {
  it("each KPI card of the six tabs names a registered metric whose labels include the card's label", () => {
    let cards = 0;
    for (const [section, file] of Object.entries(PAGES)) {
      for (const c of kpiCards(read(file))) {
        cards++;
        expect(c.metric, `${file}: « ${c.label} » has no metric`).not.toBeNull();
        const doc = ANALYTICS_METRICS[c.metric as AnalyticsMetricId];
        expect(doc, `${file}: unknown metric ${c.metric}`).toBeDefined();
        expect(doc.labels).toContain(c.label);
        expect(doc.sections).toContain(section);
      }
    }
    expect(cards).toBe(47);
  });

  it("each card title (chart, table, funnel) carries an « ⓘ » whose label matches", () => {
    let titles = 0;
    for (const file of Object.values(PAGES)) {
      for (const m of read(file).matchAll(/<CardTitle\b[^>]*>([\s\S]*?)<\/CardTitle>/g)) {
        titles++;
        const body = m[1];
        // the two product × variation tables: every COLUMN header carries its own « ⓘ » (next test)
        if (body.includes("par produit et variation")) continue;
        const metric = body.match(/<AnalyticsMetricInfo metric="([a-zA-Z]+)"/)?.[1];
        if (!metric) {
          // the dynamic store blocks of /analyses/canaux pass their id through `block.metric`
          expect(body, `${file}: a CardTitle has no « ⓘ »`).toContain("<AnalyticsMetricInfo metric={block.metric}");
          continue;
        }
        const text = decode(body.replace(/<AnalyticsMetricInfo[^>]*\/>/, "").replace(/\{period\.label\}/, "").trim());
        const labels = ANALYTICS_METRICS[metric as AnalyticsMetricId].labels;
        expect(labels.some((l) => text.startsWith(l)), `${file}: « ${text} » vs ${labels.join(" | ")}`).toBe(true);
      }
    }
    expect(titles).toBe(21);
  });

  it("the product table's columns carry their own « ⓘ »", () => {
    const src = read(PRODUCT_TABLE);
    for (const id of ["productUnits", "productOrders", "productRevenue", "productReturnedUnits", "productCost", "productGrossProfit"]) expect(src).toContain(`"${id}"`);
  });

  it("every registered metric is shown on (one of) its tabs — the only panel-only entry is the period comparison", () => {
    const sources = Object.values(PAGES).map(read).join("\n") + read(PRODUCT_TABLE);
    const notInline = ANALYTICS_METRIC_IDS.filter((id) => !sources.includes(`"${id}"`));
    expect(notInline).toEqual(["periodComparison"]);
    for (const id of ANALYTICS_METRIC_IDS) {
      for (const section of ANALYTICS_METRICS[id].sections) expect(metricsForSection(section)).toContain(id);
    }
    expect(ANALYTICS_METRIC_IDS).toHaveLength(68);
  });
});

describe("French and Arabic", () => {
  it("both languages carry the same sections, all non-empty; Arabic text is Arabic, French is not", () => {
    for (const id of ANALYTICS_METRIC_IDS) {
      const { fr, ar } = ANALYTICS_METRICS[id].text;
      expect(Object.keys(ar).sort(), id).toEqual(Object.keys(fr).sort());
      for (const k of SECTION_ORDER) {
        if (!fr[k]) continue;
        expect(fr[k]!.trim().length, `${id}.fr.${k}`).toBeGreaterThan(5);
        expect(ARABIC.test(fr[k]!), `${id}.fr.${k} contains Arabic`).toBe(false);
        expect(ARABIC.test(ar[k]!), `${id}.ar.${k} is not Arabic`).toBe(true);
      }
      expect(fr.definition && fr.calculation && fr.example, id).toBeTruthy();
    }
  });

  it("the two languages give the SAME numbers in each example (one formula, one dataset)", () => {
    const numbers = (s: string) => new Set(s.match(/\d+(?:,\d+)?/g) ?? []);
    for (const id of ANALYTICS_METRIC_IDS) {
      const fr = numbers(ANALYTICS_METRICS[id].text.fr.example);
      const ar = numbers(ANALYTICS_METRICS[id].text.ar.example);
      for (const n of fr) expect(ar.has(n), `${id}: ${n} missing from the Arabic example`).toBe(true);
    }
  });
});

describe("examples agree with the formulas", () => {
  it("the fictional dataset, checked by hand", () => {
    expect(EXAMPLE_ORDERS.map(orderTotal)).toEqual([300, 250, 360, 200, 300, 360, 165, 140, 115, 165]);
    expect(EXAMPLE).toMatchObject({
      orders: 10,
      pending: 2,
      confirmed: 7,
      wentThroughConfirmation: 9,
      confirmationRate: 77.8,
      shipped: 6,
      delivered: 3,
      failed: 1,
      returned: 1,
      inProgress: 1,
      deliveryRate: 60,
      failureRate: 20,
      returnRate: 20,
      revenueOrders: 7,
      grossRevenue: 1555,
      revenueRefunds: 85,
      netRevenue: 1470,
      averageBasket: 222.14,
      unitsSold: 12,
      deliveredRevenue: 910,
      returnedValue: 360,
      refunded: 415,
      shippingFees: 210,
      productRevenue: 1345,
      finance: { revenue: 1470, cogs: 620, grossProfit: 850, grossMarginPct: 57.8, expenses: 200, deliveryCost: 180, netProfit: 470, netMarginPct: 32 },
    });
    expect(EXAMPLE.productRevenue).toBe(EXAMPLE.grossRevenue - EXAMPLE.shippingFees);
    expect(EXAMPLE_ATTEMPTS_TOTAL).toBe(EXAMPLE_ORDERS.reduce((n, o) => n + o.attempts, 0));
    expect(EXAMPLE_STORE.byStore.reduce((n, s) => n + s.gross, 0)).toBe(EXAMPLE_STORE.sales.reduce((a, b) => a + b, 0));
  });

  it("durations in the examples are what the server's durationOf + formatHours produce", () => {
    const H = 3_600_000;
    const conf = durationOf(EXAMPLE_DURATIONS.confirmation.map((h) => h * H));
    expect(ANALYTICS_METRICS.confirmationAvgTime.text.fr.example).toContain(formatHours(conf.avgHours));
    expect(ANALYTICS_METRICS.confirmationMedianTime.text.fr.example).toContain(`médiane ${formatHours(conf.medianHours)}`);
    expect(ANALYTICS_METRICS.confirmedToShipped.text.fr.example).toContain(formatHours(durationOf(EXAMPLE_DURATIONS.confirmedToShipped.map((h) => h * H)).avgHours));
    expect(ANALYTICS_METRICS.shippedToDelivered.text.fr.example).toContain(formatHours(durationOf(EXAMPLE_DURATIONS.shippedToDelivered.map((h) => h * H)).avgHours));
  });

  it("headline examples quote the computed figures", () => {
    expect(ANALYTICS_METRICS.netRevenue.text.fr.example).toContain("1 555 MAD − 85 MAD = 1 470 MAD");
    expect(ANALYTICS_METRICS.averageBasket.text.fr.example).toContain("1 555 MAD ÷ 7 commandes valides = 222,14 MAD");
    expect(ANALYTICS_METRICS.confirmationRate.text.fr.example).toContain("7 ÷ 9 = 77,8 %");
    expect(ANALYTICS_METRICS.deliveryRate.text.fr.example).toContain("3 ÷ (3 + 1 + 1) = 60,0 %");
    expect(ANALYTICS_METRICS.orderFunnel.text.fr.example).toContain("10 → 7 (70,0 %) → 6 (60,0 %) → 3 (30,0 %)");
    expect(ANALYTICS_METRICS.netProfit.text.fr.example).toContain("850 MAD − 200 MAD − 180 MAD = 470 MAD ; marge 32,0 %");
    expect(ANALYTICS_METRICS.storeAverageTicket.text.fr.example).toContain("400 MAD ÷ 3 = 133,33 MAD");
    expect(ANALYTICS_METRICS.deliveryOutcomeBreakdown.text.fr.example).toContain("3 / 1 / 1 / 1 sur 6 → 50 % / 16,7 % / 16,7 % / 16,7 %");
  });
});

describe("Arabic is RTL inside the explanation only; the language never reaches values or the page", () => {
  it("the explanation body is lang=ar dir=rtl in Arabic, untouched in French", () => {
    const ar = renderToStaticMarkup(createElement(MetricExplanationBody, { metric: "netRevenue", lang: "ar" }));
    const fr = renderToStaticMarkup(createElement(MetricExplanationBody, { metric: "netRevenue", lang: "fr" }));
    expect(ar).toMatch(/^<div lang="ar" dir="rtl"/);
    expect(ar).toContain("طريقة الحساب");
    expect(fr).not.toContain("dir=");
    expect(fr).toContain("Calcul");
  });

  it("a KPI card keeps its French label and value; nothing in it is RTL", () => {
    const html = renderToStaticMarkup(createElement(KpiCard, { label: "Chiffre d'affaires", value: "1 470,00 MAD", metric: "netRevenue" }));
    expect(html).toContain("Chiffre d&#x27;affaires");
    expect(html).toContain("1 470,00 MAD");
    expect(html).not.toContain('dir="rtl"');
    expect(html).toContain("Comment est calculé « Chiffre d&#x27;affaires » ?");
  });

  describe("the language switch", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("only stores the viewer's choice (no document, no <html lang/dir>)", () => {
      const store = new Map<string, string>();
      const events: string[] = [];
      vi.stubGlobal("window", {
        localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
        dispatchEvent: (e: Event) => events.push(e.type),
      });
      expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined"); // touching it would throw
      setExplanationLanguage("ar");
      expect([...store.entries()]).toEqual([["asoditech.analytics.explanationLang", "ar"]]);
      expect(events).toEqual(["asoditech:explanation-lang"]);
    });
  });

  it("no query, export or permission module imports the explanations — the language cannot change a value", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const dataLayer = [...walk("src/lib/analytics"), ...walk("src/lib/queries"), "src/lib/profitability.ts", "src/app/(protected)/analyses/export/[type]/route.ts"];
    for (const f of dataLayer) expect(read(f), f).not.toMatch(/analytics-explanations|explanation-language|example-dataset/);
    for (const f of ["src/lib/metrics/analytics-explanations.ts", "src/lib/metrics/example-dataset.ts"]) {
      expect(read(f), f).not.toMatch(/@\/lib\/prisma|@\/lib\/analytics\/queries|server-only/);
    }
  });
});

describe("the former reference page is removed", () => {
  const ROUTE = "/platform/documentation/analyses-rapports";
  it("its route, page component and chapter data no longer exist", () => {
    expect(fs.existsSync(path.join(ROOT, "src/app/platform/documentation/analyses-rapports"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/components/analytics/analytics-reference.tsx"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "src/lib/metrics/analytics-reference.ts"))).toBe(false);
  });

  it("nothing in src references it", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    for (const f of walk("src").filter((f) => /\.(tsx?|mdx?)$/.test(f))) {
      const code = read(f);
      expect(code.includes(ROUTE), f).toBe(false);
      expect(code, f).not.toMatch(/analytics-reference|AnalyticsReference|REFERENCE_CHAPTERS/);
    }
  });
});
