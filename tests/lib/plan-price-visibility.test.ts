import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Prisma, type Plan } from "@prisma/client";
import { parsePlanFeatures } from "@/lib/entitlements/catalogue";
import type { TenantUsage } from "@/lib/entitlements/usage";
import { getArticleBySlug } from "@/lib/docs/registry";
import { SETTINGS_EXPLANATIONS } from "@/lib/settings/settings-explanations";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/parametres/abonnement",
}));

const { UsagePanel } = await import("@/components/settings/usage-panel");

/**
 * Subscription prices are not shown to tenants: the « Abonnement &
 * Utilisation » panel, its « ⓘ » explanation and the « Comprendre votre
 * forfait » help article. Prices stay on the Plan rows and in /platform/plans.
 */

// Any amount written as money (DH / MAD, as formatCurrency renders it too) or
// a "monthly price" wording — the usage limits (« 1 500 » commandes,
// « Commandes / mois ») are plain counts and must stay.
const PRICE = /\d[\d\s.,]*\s*(?:DH|MAD|د\.?م)|prix mensuel|ثمنها/i;

const plan: Plan = {
  id: "plan-business",
  code: "BUSINESS",
  name: "Business",
  isActive: true,
  sortOrder: 1,
  installationPriceMad: new Prisma.Decimal(1500),
  monthlyPriceMad: new Prisma.Decimal(599),
  maxOrdersPerMonth: 1500,
  maxUsers: 7,
  maxWarehouses: 3,
  features: {},
  createdAt: new Date("2026-09-12T00:00:00Z"),
  updatedAt: new Date("2026-09-12T00:00:00Z"),
};
const features = parsePlanFeatures({
  orders: true, users: true, warehouses: true, woocommerce: true, shopify: true,
  reports: "standard", profitability: "standard", backup: "standard",
  aiAssistant: true, integrations: true, notifications: true, commissions: true, finance: true, support: "standard",
});
const usage: TenantUsage = {
  period: "2026-10",
  orders: { used: 1200, limit: 1500, status: "CRITICAL", percent: 80 },
  users: { used: 3, limit: 7, status: "NORMAL", percent: 43 },
  warehouses: { used: 1, limit: 3, status: "NORMAL", percent: 33 },
  storage: null,
};

const render = (subscriptionStatus: "ACTIVE" | "TRIALING" | "PAST_DUE" = "ACTIVE") =>
  renderToStaticMarkup(createElement(UsagePanel, { plan, subscriptionStatus, features, usage, canRequestUpgrade: true }));

describe("« Abonnement & Utilisation » panel", () => {
  it("never renders the plan's price, even though the plan row carries one", () => {
    const html = render();
    expect(html).not.toMatch(PRICE);
    expect(html).not.toContain("599");
    expect(html).not.toContain("1 500,00");
  });

  it("keeps the plan name, subscription status, period, usage, features and the upgrade action", () => {
    expect(render("TRIALING")).toContain("Essai");
    expect(render("PAST_DUE")).toContain("Paiement en retard");
    const html = render();
    expect(html).toContain("Business");
    expect(html).toContain("Forfait actuel");
    expect(html).toContain("octobre 2026");
    expect(html).toContain("Commandes ce mois-ci");
    expect(html).toContain("Fonctionnalités incluses");
    expect(html).toContain("Voir le forfait PRO"); // upgrade request still offered
  });
});

describe("help content shown to tenants", () => {
  it("« Comprendre votre forfait » lists no price but keeps the plan comparison (limits, features)", () => {
    const article = getArticleBySlug("abonnement/comprendre-votre-forfait");
    expect(article).toBeDefined();
    const text = JSON.stringify(article);
    expect(text).not.toMatch(PRICE);
    for (const old of ["1 500 DH", "2 500 DH", "599 DH", "1 000 DH", "Installation (unique)", "Abonnement mensuel"]) {
      expect(text).not.toContain(old);
    }
    expect(text).toContain("Commandes / mois (environ)");
    expect(text).toContain("Utilisateurs actifs");
    expect(text).toContain("Entrepôts actifs");
  });

  it("the « Forfait actuel » ⓘ explanation (French and Arabic) mentions no price", () => {
    const text = JSON.stringify(SETTINGS_EXPLANATIONS.currentPlan);
    expect(text).not.toMatch(PRICE);
    expect(text).toContain("Essai");
  });
});

describe("billing data is untouched (presentation-only change)", () => {
  it("the Plan price columns, their validation and the platform price editor are still in place", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(read("prisma/schema.prisma")).toMatch(/installationPriceMad\s+Decimal[\s\S]*monthlyPriceMad\s+Decimal/);
    expect(read("src/lib/validation/plan.ts")).toContain("monthlyPriceMad: z.coerce.number().min(0)");
    expect(read("src/components/platform/plan-edit-form.tsx")).toContain('formData.set("monthlyPriceMad", monthlyPrice)');
  });
});
