import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ANALYTICS_METRICS, SECTION_ORDER } from "@/lib/metrics/analytics-explanations";
import { DASHBOARD_METRIC_IDS, DASHBOARD_METRICS, type DashboardMetricId } from "@/lib/metrics/dashboard-explanations";
import { ExplanationBody } from "@/components/analytics/metric-explanation";

/**
 * Dashboard explanations: every figure, chart and list of /tableau-de-bord
 * carries an « ⓘ » backed by a registered explanation in French AND Arabic;
 * the explanations never reach a query.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PAGE = "src/app/(protected)/tableau-de-bord/page.tsx";
const ARABIC = /[؀-ۿ]/;
const src = read(PAGE);
const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

const referencedIds = (s: string) => new Set([...s.matchAll(/<DashboardMetricInfo metric="([a-zA-Z]+)"/g)].map((m) => m[1]));
/** Each `<Tag …` of the page source, up to the next tag of the same kind or the closing `/>`. */
const chunks = (tag: string) => src.split(`<${tag}`).slice(1).map((chunk) => chunk.split(/\} \/>\n|\n\s*\/>/)[0]);

describe("every dashboard figure has a registered explanation", () => {
  it("each KpiCard carries explain={<DashboardMetricInfo metric=…/>} — and none still uses the French-only glossary", () => {
    const cards = chunks("KpiCard");
    expect(cards).toHaveLength(9);
    for (const body of cards) expect(body, body.slice(0, 80)).toMatch(/explain=\{<DashboardMetricInfo metric="[a-zA-Z]+"/);
    expect(src).not.toMatch(/\binfo="/);
  });

  it("each CommandHero headline, each hero stat, the stock donut and each breakdown row carries an « ⓘ »", () => {
    const heroes = chunks("CommandHero");
    expect(heroes).toHaveLength(3);
    for (const body of heroes) expect(body).toMatch(/explain=\{<DashboardMetricInfo metric=/);
    for (const id of ["ordersPlaced", "averageBasket", "newCustomers"]) expect(src).toContain(`explain: <DashboardMetricInfo metric="${id}" />`);
    // « Stock physique » (Soft UI donut): its « ⓘ » sits in the card title.
    expect(src).toMatch(/<CardTitle\b[^>]*>[\s\S]*?Stock physique[\s\S]*?<DashboardMetricInfo metric="stockOnHand"[\s\S]*?<\/CardTitle>/);
    expect(src).toContain("<StockDonut");
    for (const id of ["toConfirm", "confirmedThisMonth", "toRecall", "commissionEarned", "commissionRemaining"]) {
      expect(src).toContain(`explain: <DashboardMetricInfo metric="${id}" />`);
    }
  });

  it("each card title carries an « ⓘ » (the Commissions card explains each of its two rows instead)", () => {
    let titles = 0;
    for (const m of src.matchAll(/<CardTitle\b[^>]*>([\s\S]*?)<\/CardTitle>/g)) {
      titles++;
      if (m[1].includes("Commissions")) continue;
      expect(m[1], m[1]).toContain("<DashboardMetricInfo metric");
    }
    expect(titles).toBe(7);
  });

  it("every id used exists, every registered id is shown, and the page has its definitions panel", () => {
    const used = referencedIds(src);
    for (const id of used) expect(DASHBOARD_METRICS[id as DashboardMetricId], id).toBeDefined();
    expect(DASHBOARD_METRIC_IDS.filter((id) => !used.has(id))).toEqual([]);
    expect(src).toContain("<DashboardDefinitions />");
  });
});

describe("shared with /analyses", () => {
  it("a figure with the same formula, population and period reuses the /analyses text (only « Filtres » describes the dashboard)", () => {
    const shared = DASHBOARD_METRIC_IDS.filter((id) => "sharedWith" in DASHBOARD_METRICS[id]);
    expect(shared.sort()).toEqual(["averageBasket", "netProfit"]);
    for (const id of shared) {
      const doc = DASHBOARD_METRICS[id] as { sharedWith?: keyof typeof ANALYTICS_METRICS; text: unknown };
      // Same /analyses text for every section except « Filtres » (no Origine filter on the dashboard).
      const analyticsText = ANALYTICS_METRICS[doc.sharedWith!].text;
      const own = doc.text as typeof analyticsText;
      for (const lang of ["fr", "ar"] as const) {
        expect({ ...own[lang], filters: undefined }).toEqual({ ...analyticsText[lang], filters: undefined });
        expect(own[lang].filters).not.toBe(analyticsText[lang].filters);
        expect(own[lang].filters).toContain("Tous / En ligne / Magasin");
      }
    }
  });

  it("dashboard-specific entries are not copies of an /analyses text", () => {
    const analyticsTexts = new Set(Object.values(ANALYTICS_METRICS).map((m) => m.text.fr.calculation));
    for (const id of DASHBOARD_METRIC_IDS) {
      if ("sharedWith" in DASHBOARD_METRICS[id]) continue;
      expect(analyticsTexts.has(DASHBOARD_METRICS[id].text.fr.calculation), id).toBe(false);
    }
  });
});

describe("French and Arabic", () => {
  it("same sections, non-empty; Arabic is Arabic, French is not", () => {
    for (const id of DASHBOARD_METRIC_IDS) {
      const { fr, ar } = DASHBOARD_METRICS[id].text;
      expect(Object.keys(ar).sort(), id).toEqual(Object.keys(fr).sort());
      for (const k of SECTION_ORDER) {
        if (!fr[k]) continue;
        expect(ARABIC.test(fr[k]!), `${id}.fr.${k}`).toBe(false);
        expect(ARABIC.test(ar[k]!), `${id}.ar.${k}`).toBe(true);
      }
      expect(fr.definition && fr.calculation && fr.example, id).toBeTruthy();
      for (const k of SECTION_ORDER) for (const t of [fr[k], ar[k]]) if (t) expect(t, `${id}.${k}`).not.toMatch(/undefined|NaN|\[object/);
      expect(DASHBOARD_METRICS[id].source && DASHBOARD_METRICS[id].access, id).toBeTruthy();
    }
  });

  it("the two languages give the same numbers in each example", () => {
    const numbers = (s: string) => new Set(s.match(/\d+(?:,\d+)?/g) ?? []);
    for (const id of DASHBOARD_METRIC_IDS) {
      const ar = numbers(DASHBOARD_METRICS[id].text.ar.example);
      for (const n of numbers(DASHBOARD_METRICS[id].text.fr.example)) expect(ar.has(n), `${id}: ${n}`).toBe(true);
    }
  });
});

describe("examples agree with the dashboard formulas", () => {
  it("headline examples, checked by hand", () => {
    const ex = (id: DashboardMetricId) => nbsp(DASHBOARD_METRICS[id].text.fr.example);
    expect(ex("totalRevenue")).toContain("1 470 MAD + magasin 320 MAD (400 MAD − 80 MAD) = 1 790 MAD");
    expect(ex("revenue")).toContain("1 555 MAD ; 85 MAD remboursés sur CMD-103 → 1 470 MAD");
    expect(ex("revenue")).toContain("1 200 MAD → flèche +22.5%");
    expect(ex("storeNetSales")).toContain("→ 320 MAD, « 3 vente(s) · 5 article(s) »");
    expect(ex("charges")).toContain("200 MAD de publicité + livraison 4 × 35 + 20 (échec CMD-105) + 20 (retour CMD-106) = 180 MAD → 380 MAD");
    expect(ex("stockOnHand")).toContain("physique 42, réservé 7, disponible 35");
    expect(ex("lowStock")).toContain("4 disponibles ≤ 5");
    expect(ex("toConfirm")).toContain("CMD-109 et CMD-110 sont « Nouvelle » → 2");
    expect(ex("toRecall")).toContain("CMD-109 (1 appel sans réponse) → 1");
    expect(ex("confirmedThisMonth")).toContain("7 tentatives « Confirmé » ce mois sur 7 commandes");
    expect(ex("commissionEarned")).toContain("3 livraisons ce mois → 30 MAD");
    expect(ex("commissionRemaining")).toContain("→ 70 MAD restants");
    expect(ex("deliveryRate")).toContain("3 ÷ 5 = 60.0% ; « 3 livrée(s) sur 5 terminée(s) »");
    expect(ex("topSelling")).toContain("Sac Atlas 5 (675 MAD), Ceinture Fès 4 (340 MAD), Foulard Rif 3 (330 MAD)");
    expect(ex("revenueTrend")).toContain("= 1 470 MAD");
  });
});

describe("Arabic is RTL inside the explanation only; explanations never reach the data layer", () => {
  it("renders lang=ar dir=rtl for Arabic, nothing for French", () => {
    const ar = renderToStaticMarkup(createElement(ExplanationBody, { text: DASHBOARD_METRICS.deliveryRate.text, lang: "ar" }));
    const fr = renderToStaticMarkup(createElement(ExplanationBody, { text: DASHBOARD_METRICS.deliveryRate.text, lang: "fr" }));
    expect(ar).toMatch(/^<div lang="ar" dir="rtl"/);
    expect(ar.match(/dir="rtl"/g)).toHaveLength(1);
    expect(fr).not.toContain("dir=");
    // The page itself never sets a direction: only the explanation body does.
    expect(src).not.toMatch(/dir=|lang="ar"/);
  });

  it("no query or data module imports the dashboard explanations", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    for (const f of [...walk("src/lib/queries"), ...walk("src/lib/analytics"), ...walk("src/actions"), "src/lib/profitability.ts", "src/lib/inventory.ts", "src/lib/commissions.ts"]) {
      if (!fs.existsSync(path.join(ROOT, f))) continue;
      expect(read(f), f).not.toMatch(/dashboard-explanations|dashboard-metric-info|dashboard-definitions/);
    }
    expect(read("src/lib/metrics/dashboard-explanations.ts")).not.toMatch(/@\/lib\/prisma|@\/lib\/queries|server-only/);
  });
});
