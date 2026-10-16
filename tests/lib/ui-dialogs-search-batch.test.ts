import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/commandes",
  useSearchParams: () => new URLSearchParams(),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { WebhookUrlField, deliveryWebhookPath } = await import("@/components/delivery/provider-connection");
const { searchTermHref } = await import("@/components/filter-search-input");
const { quickSearchCountLabel, QUICK_SEARCH_DEBOUNCE_MS, QUICK_SEARCH_MIN_CHARS } = await import("@/components/layout/command-palette");
const { orderSearchFeedback } = await import("@/lib/orders/search-feedback");
const { orderNumberPrefixRanges, quickSearchOrderDigits } = await import("@/lib/queries/order-quick-search");

const src = (p: string) => readFileSync(path.resolve(import.meta.dirname, "../..", p), "utf8");

describe("Configurer le connecteur — Annuler + webhook URL", () => {
  it("the dialog footer has an « Annuler » DialogClose (type=button, closes without submitting)", () => {
    const file = src("src/components/delivery/provider-connection.tsx");
    expect(file).toMatch(/<DialogClose render=\{<Button type="button" variant="outline"[^>]*\/>\}>Annuler<\/DialogClose>/);
  });

  it("webhook path carries only the connection id", () => {
    expect(deliveryWebhookPath("cl_abc123")).toBe("/api/webhooks/delivery/cl_abc123");
  });

  it("shows the FULL URL in a read-only monospace field that wraps, a « Copier » button and a polite live region", () => {
    const url = "https://www.example.test/api/webhooks/delivery/cmabcdefghijklmnopqrstuvwx";
    const html = renderToStaticMarkup(createElement(WebhookUrlField, { url }));
    expect(html).toContain(url);
    expect(html).toMatch(/<textarea[^>]*readOnly|<textarea[^>]*readonly/i);
    expect(html).toContain("break-all");
    expect(html).toContain("font-mono");
    expect(html).toContain("Copier");
    expect(html).toContain('aria-label="Copier l&#x27;URL du webhook"');
    expect(html).toMatch(/aria-live="polite"/);
  });

  it("never renders a secret value — only the instruction to enter it", () => {
    const html = renderToStaticMarkup(createElement(WebhookUrlField, { url: "https://x.test/api/webhooks/delivery/id1" }));
    expect(html).not.toMatch(/value="[^"]*secret/i);
    expect(html).toContain("Le secret n&#x27;est jamais réaffiché");
  });
});

describe("/commandes search — live URL + feedback", () => {
  it("merges the term, keeps other filters, resets the page, drops an empty term", () => {
    expect(searchTermHref("/commandes", "status=LIVREE&page=3", "q", " sara ")).toBe("/commandes?status=LIVREE&q=sara");
    expect(searchTermHref("/commandes", "q=sara&page=2", "q", "")).toBe("/commandes");
  });

  it("« x résultats / aucun résultat » with the month scope named", () => {
    expect(orderSearchFeedback({ q: "", total: 3, scopedToThisMonth: true })).toBeNull();
    expect(orderSearchFeedback({ q: "sara", total: 1, scopedToThisMonth: false })).toBe("1 résultat pour « sara ».");
    expect(orderSearchFeedback({ q: "sara", total: 12, scopedToThisMonth: true })).toBe("12 résultats pour « sara » ce mois-ci.");
    expect(orderSearchFeedback({ q: "zz", total: 0, scopedToThisMonth: true })).toBe(
      "Aucun résultat pour « zz » ce mois-ci — essayez « Toute la période »."
    );
    expect(orderSearchFeedback({ q: "zz", total: 0, scopedToThisMonth: false })).toBe("Aucun résultat pour « zz ».");
  });

  it("the orders page opts into the live mode and renders the feedback in a status region", () => {
    const page = src("src/app/(protected)/commandes/page.tsx");
    expect(page).toContain("liveDebounceMs={300}");
    expect(page).toMatch(/role="status" aria-live="polite"[^>]*data-testid="orders-search-feedback"/);
  });
});

describe("⌘K — partial order number + palette constants", () => {
  it("plain digits: the number starts with them, up to the Int max", () => {
    const r = orderNumberPrefixRanges("14");
    expect(r[0]).toEqual({ gte: 14, lte: 14 });
    expect(r[1]).toEqual({ gte: 140, lte: 149 });
    expect(r[2]).toEqual({ gte: 1400, lte: 1499 });
    expect(r.at(-1)!.lte).toBeLessThanOrEqual(2_147_483_647);
  });

  it("leading zeros: the 6-digit padded form starts with them", () => {
    expect(orderNumberPrefixRanges("0001")).toEqual([{ gte: 100, lte: 199 }]);
    expect(orderNumberPrefixRanges("000140")).toEqual([{ gte: 140, lte: 140 }]);
    expect(orderNumberPrefixRanges("0000")).toEqual([{ gte: 1, lte: 99 }]);
    expect(orderNumberPrefixRanges("0000001")).toEqual([]);
    expect(orderNumberPrefixRanges("abc")).toEqual([]);
  });

  it("reads the typed digits after the configured prefix or « CMD », never a phone or text", () => {
    expect(quickSearchOrderDigits("CMD-0000")).toBe("0000");
    expect(quickSearchOrderDigits("cmd 14")).toBe("14");
    expect(quickSearchOrderDigits("BL/26-00014", "BL/26")).toBe("00014");
    expect(quickSearchOrderDigits("14")).toBe("14");
    for (const q of ["0612345678", "OZ123456", "Article 12", "CMD-", "+212 612"]) expect(quickSearchOrderDigits(q), q).toBeNull();
  });

  it("debounce ~250 ms, 2 characters minimum, result count wording", () => {
    expect(QUICK_SEARCH_DEBOUNCE_MS).toBe(250);
    expect(QUICK_SEARCH_MIN_CHARS).toBe(2);
    expect(quickSearchCountLabel(0)).toBe("Aucun résultat");
    expect(quickSearchCountLabel(1)).toBe("1 résultat");
    expect(quickSearchCountLabel(4)).toBe("4 résultats");
  });
});

describe("Paramètres › Notifications — subtitle describes the page", () => {
  it("no longer the generic « Informations de l'entreprise » text", () => {
    const page = src("src/app/(protected)/parametres/notifications/page.tsx");
    expect(page).not.toContain("Informations de l'entreprise et préférences générales.");
    expect(page).toContain("Ces réglages ne concernent que votre compte");
    for (const word of ["application", "email", "WhatsApp", "rôle"]) expect(page).toContain(word);
  });
});
