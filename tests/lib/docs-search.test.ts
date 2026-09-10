import { describe, expect, it } from "vitest";
import { ALL_ARTICLES } from "@/lib/docs/registry";
import { searchArticles } from "@/lib/docs/search";

/**
 * The 3 example queries from the Documentation/Demo Center spec must
 * resolve to the categories the spec names for them.
 */
describe("Documentation search", () => {
  it("'Je ne peux pas envoyer la commande' surfaces Livraison / création d'expédition", () => {
    const results = searchArticles(ALL_ARTICLES, "Je ne peux pas envoyer la commande");
    expect(results.length).toBeGreaterThan(0);
    const categories = results.map((r) => r.article.category);
    expect(categories).toContain("livraison");
    expect(results.some((r) => r.article.slug.includes("creer-une-expedition"))).toBe(true);
  });

  it("'Pourquoi mon produit est à 0' surfaces the stock/produit KB entry", () => {
    const results = searchArticles(ALL_ARTICLES, "Pourquoi mon produit est à 0");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.article.slug.includes("produit-affiche-a-0") || r.article.category === "stock")).toBe(true);
  });

  it("'coût manquant' surfaces Coûts / Snapshots / Rétroactivité", () => {
    const results = searchArticles(ALL_ARTICLES, "coût manquant");
    expect(results.length).toBeGreaterThan(0);
    const slugs = results.map((r) => r.article.slug);
    expect(slugs.some((s) => s.includes("cout") || s.includes("snapshot"))).toBe(true);
  });

  it("finds an article by its verbatim thrown error text", () => {
    const results = searchArticles(ALL_ARTICLES, "Entrepôt de préparation invalide");
    expect(results.some((r) => r.article.category === "stock" || r.article.category === "troubleshooting")).toBe(true);
  });

  it("returns nothing for an empty query", () => {
    expect(searchArticles(ALL_ARTICLES, "")).toEqual([]);
  });

  it("returns nothing for a nonsense query", () => {
    expect(searchArticles(ALL_ARTICLES, "zzzqqqxxxnonexistent")).toEqual([]);
  });
});
