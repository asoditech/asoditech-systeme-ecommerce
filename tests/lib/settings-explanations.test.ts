import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SETTINGS_EXPLANATIONS, SETTINGS_SECTION_TITLES, SETTING_IDS, type SettingId } from "@/lib/settings/settings-explanations";
import { SECTION_ORDER } from "@/lib/metrics/analytics-explanations";
import { ExplanationBody } from "@/components/analytics/metric-explanation";
import { identityCompletion, orderNumberPreview } from "@/lib/settings/configuration-model";
import { computeUsageStatus } from "@/lib/entitlements/catalogue";
import { computeUpdatedCost } from "@/lib/catalog/costing";
import { Prisma } from "@prisma/client";

/**
 * /parametres explanations: every setting, switch and figure wired to an
 * « ⓘ » has a French AND Arabic explanation, the examples agree with the
 * code they describe, and Arabic is RTL only inside the explanation.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const SETTINGS_SOURCES = walk("src/components/settings").filter((f) => f.endsWith(".tsx"));
const ARABIC = /[؀-ۿ]/;

describe("every registered setting is wired, every wired id exists", () => {
  const sources = SETTINGS_SOURCES.map(read).join("\n");

  it("each registry entry is referenced by a settings component", () => {
    const unwired = SETTING_IDS.filter((id) => !sources.includes(`"${id}"`));
    expect(unwired).toEqual([]);
    expect(SETTING_IDS.length).toBe(57);
  });

  it("each <SettingInfo setting=…> / info=… id is a registry id", () => {
    const ids = new Set([
      ...[...sources.matchAll(/<SettingInfo setting="([a-zA-Z]+)"/g)].map((m) => m[1]),
      ...[...sources.matchAll(/\binfo(?::|=)\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
    ]);
    expect(ids.size).toBeGreaterThan(40);
    for (const id of ids) expect(SETTING_IDS, id).toContain(id as SettingId);
  });

  it("the five /parametres screens each show explanations", () => {
    for (const s of ["configuration", "abonnement", "canaux", "notifications", "sauvegarde"] as const) {
      expect(SETTING_IDS.some((id) => (SETTINGS_EXPLANATIONS[id].screens as readonly string[]).includes(s)), s).toBe(true);
    }
  });
});

describe("French and Arabic", () => {
  it("same sections in both languages, non-empty; Arabic is Arabic, French is not", () => {
    for (const id of SETTING_IDS) {
      const { fr, ar } = SETTINGS_EXPLANATIONS[id].text;
      expect(Object.keys(ar).sort(), id).toEqual(Object.keys(fr).sort());
      for (const k of SECTION_ORDER) {
        if (!fr[k]) continue;
        expect(fr[k]!.trim().length, `${id}.fr.${k}`).toBeGreaterThan(3);
        expect(ARABIC.test(fr[k]!), `${id}.fr.${k} contains Arabic`).toBe(false);
        expect(ARABIC.test(ar[k]!), `${id}.ar.${k} is not Arabic`).toBe(true);
      }
      expect(fr.definition && fr.calculation && fr.example, id).toBeTruthy();
    }
  });

  it("the Arabic example carries every number of the French one", () => {
    const numbers = (s: string) => new Set(s.match(/\d+(?:,\d+)?/g) ?? []);
    for (const id of SETTING_IDS) {
      const ar = numbers(SETTINGS_EXPLANATIONS[id].text.ar.example);
      for (const n of numbers(SETTINGS_EXPLANATIONS[id].text.fr.example)) expect(ar.has(n), `${id}: ${n}`).toBe(true);
    }
  });
});

describe("examples agree with the code they describe", () => {
  it("identity completeness: 4 of 6 → 67 %", () => {
    const s = { companyName: "Boutique Exemple", logoUrl: "https://x", email: "a@b.ma", phone: null, address: null, city: "Casablanca" };
    expect(identityCompletion(s as never).percent).toBe(67);
    expect(SETTINGS_EXPLANATIONS.identityCompletion.text.fr.example).toContain("4 ÷ 6 = 67 %");
  });

  it("order number preview: BX + 124 → BX-000124", () => {
    expect(orderNumberPreview("BX")).toBe("BX-000124");
    expect(SETTINGS_EXPLANATIONS.orderNumberPrefix.text.fr.example).toContain("BX-000124");
  });

  it("usage status: 1 230 of 1 500 is 82 % → WARNING (🟠)", () => {
    expect(computeUsageStatus(1230, 1500)).toBe("WARNING");
    expect(computeUsageStatus(1350, 1500)).toBe("CRITICAL");
    expect(computeUsageStatus(1500, 1500)).toBe("LIMIT_REACHED");
    expect(SETTINGS_EXPLANATIONS.usageStatus.text.fr.example).toContain("82 % → 🟠");
  });

  it("costing method: 10 × 50 then 10 × 60 → last 60, weighted 55", () => {
    const base = { existingOnHand: 10, existingCost: new Prisma.Decimal(50), receivedQty: 10, receivedUnitCost: new Prisma.Decimal(60) };
    expect(computeUpdatedCost({ ...base, method: "LAST_COST" })!.toNumber()).toBe(60);
    expect(computeUpdatedCost({ ...base, method: "WEIGHTED_AVERAGE" })!.toNumber()).toBe(55);
    expect(computeUpdatedCost({ ...base, method: "MANUAL" })!.toNumber()).toBe(50);
    expect(SETTINGS_EXPLANATIONS.costingMethod.text.fr.example).toContain("÷ 20 = 55 MAD");
  });
});

describe("Arabic is RTL inside the explanation only, with the settings headings", () => {
  it("renders « Effet » / « التأثير » instead of « Calcul »", () => {
    const text = SETTINGS_EXPLANATIONS.packingVerification.text;
    const ar = renderToStaticMarkup(createElement(ExplanationBody, { text, lang: "ar", titles: SETTINGS_SECTION_TITLES }));
    const fr = renderToStaticMarkup(createElement(ExplanationBody, { text, lang: "fr", titles: SETTINGS_SECTION_TITLES }));
    expect(ar).toMatch(/^<div lang="ar" dir="rtl"/);
    expect(ar).toContain("التأثير");
    expect(ar).not.toContain("طريقة الحساب");
    expect(fr).not.toContain("dir=");
    expect(fr).toContain("Effet");
    expect(fr).not.toContain(">Calcul<");
  });

  it("the registry is client-safe and no server code reads it", () => {
    expect(read("src/lib/settings/settings-explanations.ts")).not.toMatch(/@\/lib\/prisma|server-only|@\/actions/);
    for (const f of [...walk("src/actions"), ...walk("src/lib/queries"), "src/lib/settings/configuration-model.ts"]) {
      expect(read(f), f).not.toMatch(/settings-explanations/);
    }
  });
});
