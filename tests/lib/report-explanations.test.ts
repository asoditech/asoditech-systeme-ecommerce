import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SECTION_ORDER } from "@/lib/metrics/analytics-explanations";
import { REPORT_METRIC_IDS, REPORT_METRICS, metricsForReport, type ReportId, type ReportMetricId } from "@/lib/metrics/report-explanations";
import { ExplanationBody } from "@/components/analytics/metric-explanation";

/**
 * /rapports explanations: every figure, chart and table of the report pages
 * carries an « ⓘ » backed by a registered explanation in French AND Arabic;
 * the explanations never reach a query or an export.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PAGES: Record<ReportId, string> = {
  ventes: "src/app/(protected)/rapports/ventes/page.tsx",
  canaux: "src/app/(protected)/rapports/canaux/page.tsx",
  livraison: "src/app/(protected)/rapports/livraison/page.tsx",
  tresorerie: "src/app/(protected)/rapports/tresorerie/page.tsx",
  stock: "src/app/(protected)/rapports/stock/page.tsx",
  clients: "src/app/(protected)/rapports/clients/page.tsx",
  retours: "src/app/(protected)/rapports/retours/page.tsx",
  rentabilite: "src/app/(protected)/rapports/rentabilite/page.tsx",
  profitabilite: "src/app/(protected)/rapports/profitabilite/page.tsx",
  "profitabilite-produit": "src/app/(protected)/rapports/profitabilite/produit/[productId]/page.tsx",
  "profitabilite-campagne": "src/app/(protected)/rapports/profitabilite/campagne/[campaignId]/page.tsx",
};
const ARABIC = /[؀-ۿ]/;

/** Every metric id a page source references, literal or in a `view ? "a" : "b"` choice. */
const referencedIds = (src: string) =>
  new Set([
    ...[...src.matchAll(/metric="([a-zA-Z]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/metric=\{[^}]*\? "([a-zA-Z]+)" : "([a-zA-Z]+)"\}/g)].flatMap((m) => [m[1], m[2]]),
  ]);

/** Each `<KpiCard …` of a page source, up to the next card or closing tag. */
const kpiCards = (src: string) => src.split("<KpiCard").slice(1).map((chunk) => chunk.split(/<KpiCard|<\/div>/)[0]);

describe("every report figure has a registered explanation", () => {
  it("each KPI card carries explain={<ReportMetricInfo metric=…/>} with a matching label and report", () => {
    let cards = 0;
    for (const [report, file] of Object.entries(PAGES) as [ReportId, string][]) {
      for (const body of kpiCards(read(file))) {
        cards++;
        const metric = body.match(/explain=\{<ReportMetricInfo metric="([a-zA-Z]+)"/)?.[1] as ReportMetricId | undefined;
        expect(metric, `${file}: a KpiCard has no « ⓘ »`).toBeDefined();
        const doc = REPORT_METRICS[metric!];
        expect(doc, `${file}: unknown ${metric}`).toBeDefined();
        expect(doc.reports).toContain(report);
        const label = body.match(/^\s*label="([^"]+)"/)?.[1];
        if (label) expect(doc.labels).toContain(label);
        else expect(body).toContain("Articles dormants"); // the one templated label
      }
    }
    expect(cards).toBe(56);
  });

  it("each card title carries an « ⓘ »", () => {
    let titles = 0;
    for (const file of Object.values(PAGES)) {
      for (const m of read(file).matchAll(/<CardTitle\b[^>]*>([\s\S]*?)<\/CardTitle>/g)) {
        titles++;
        expect(m[1], `${file}: a CardTitle has no « ⓘ »`).toContain("<ReportMetricInfo metric");
      }
    }
    expect(titles).toBe(24);
  });

  it("the sales hero and its three stats carry an « ⓘ »", () => {
    const src = read(PAGES.ventes);
    for (const id of ["salesRevenue", "salesOrders", "salesAverageBasket", "salesUnits"]) expect(src).toContain(`metric="${id}"`);
  });

  it("every registered id is shown on (one of) its pages — the comparison arrow is explained in the panel only", () => {
    const used = new Set(Object.values(PAGES).flatMap((f) => [...referencedIds(read(f))]));
    expect(REPORT_METRIC_IDS.filter((id) => !used.has(id))).toEqual(["salesComparison"]);
    for (const [report, file] of Object.entries(PAGES) as [ReportId, string][]) {
      // `exclude` may hide the entry of a view that is itself hidden (profitabilité « Par campagne »).
      expect(read(file), file).toContain(`<ReportDefinitions report="${report}"`);
      for (const id of referencedIds(read(file))) expect(metricsForReport(report), `${file}: ${id}`).toContain(id);
    }
  });
});

describe("French and Arabic", () => {
  it("same sections, non-empty; Arabic is Arabic, French is not", () => {
    for (const id of REPORT_METRIC_IDS) {
      const { fr, ar } = REPORT_METRICS[id].text;
      expect(Object.keys(ar).sort(), id).toEqual(Object.keys(fr).sort());
      for (const k of SECTION_ORDER) {
        if (!fr[k]) continue;
        expect(ARABIC.test(fr[k]!), `${id}.fr.${k}`).toBe(false);
        expect(ARABIC.test(ar[k]!), `${id}.ar.${k}`).toBe(true);
      }
      expect(fr.definition && fr.calculation && fr.example, id).toBeTruthy();
    }
  });

  it("the two languages give the same numbers in each example", () => {
    const numbers = (s: string) => new Set(s.match(/\d+(?:,\d+)?/g) ?? []);
    for (const id of REPORT_METRIC_IDS) {
      const ar = numbers(REPORT_METRICS[id].text.ar.example);
      for (const n of numbers(REPORT_METRICS[id].text.fr.example)) expect(ar.has(n), `${id}: ${n}`).toBe(true);
    }
  });
});

describe("examples agree with the report formulas", () => {
  it("headline examples, checked by hand", () => {
    expect(REPORT_METRICS.salesRevenue.text.fr.example).toContain("1 470 MAD");
    expect(REPORT_METRICS.channelsTotal.text.fr.example).toContain("1 470 MAD + 320 MAD = 1 790 MAD");
    expect(REPORT_METRICS.marginGross.text.fr.example).toContain("1 345 MAD − 620 MAD = 725 MAD");
    expect(REPORT_METRICS.marginPct.text.fr.example).toContain("53,9 %");
    expect(REPORT_METRICS.profitProfit.text.fr.example).toContain("1 345 MAD − 620 MAD − 180 MAD = 545 MAD");
    expect(REPORT_METRICS.profitDeliveryCost.text.fr.example).toContain("= 69,32 MAD");
    expect(REPORT_METRICS.profitMargin.text.fr.example).toContain("40,5 %");
    expect(REPORT_METRICS.deliveryAvgDays.text.fr.example).toContain("2,2 j");
    expect(REPORT_METRICS.deliveryCodPending.text.fr.example).toContain("560 MAD");
    expect(REPORT_METRICS.customersRepeatRate.text.fr.example).toBe("2 ÷ 5 = 40,0 %.");
  });
});

describe("Arabic is RTL inside the explanation only; explanations never reach the data layer", () => {
  it("renders lang=ar dir=rtl for Arabic, nothing for French", () => {
    const ar = renderToStaticMarkup(createElement(ExplanationBody, { text: REPORT_METRICS.cashNet.text, lang: "ar" }));
    const fr = renderToStaticMarkup(createElement(ExplanationBody, { text: REPORT_METRICS.cashNet.text, lang: "fr" }));
    expect(ar).toMatch(/^<div lang="ar" dir="rtl"/);
    expect(fr).not.toContain("dir=");
  });

  it("no query or report export imports the report explanations", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    for (const f of [...walk("src/lib/queries"), ...walk("src/app/(protected)/rapports/export"), "src/lib/profitability.ts"]) {
      expect(read(f), f).not.toMatch(/report-explanations|report-metric-info|report-definitions/);
    }
    expect(read("src/lib/metrics/report-explanations.ts")).not.toMatch(/@\/lib\/prisma|@\/lib\/queries|server-only/);
  });
});
