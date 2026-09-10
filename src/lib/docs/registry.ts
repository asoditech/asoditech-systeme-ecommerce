import type { DocArticle, DocCategoryId } from "./types";
import { bienDemarrerArticles } from "./content/bien-demarrer";
import { integrationsArticles } from "./content/integrations";
import { produitsArticles } from "./content/produits";
import { clientsArticles } from "./content/clients";
import { commandesArticles } from "./content/commandes";
import { stockArticles } from "./content/stock";
import { confirmationArticles } from "./content/confirmation";
import { livraisonArticles } from "./content/livraison";
import { financeArticles } from "./content/finance";
import { rapportsArticles } from "./content/rapports";
import { utilisateursArticles } from "./content/utilisateurs";
import { sauvegardeArticles } from "./content/sauvegarde";
import { parametresArticles } from "./content/parametres";
import { troubleshootingArticles } from "./content/troubleshooting";

/**
 * The single source of truth for every Documentation/Demo Center article.
 * See docs/CONTRIBUTING.md — adding a category file here is how new
 * documentation joins the registry.
 */
export const ALL_ARTICLES: DocArticle[] = [
  ...bienDemarrerArticles,
  ...integrationsArticles,
  ...produitsArticles,
  ...clientsArticles,
  ...commandesArticles,
  ...stockArticles,
  ...confirmationArticles,
  ...livraisonArticles,
  ...financeArticles,
  ...rapportsArticles,
  ...utilisateursArticles,
  ...sauvegardeArticles,
  ...parametresArticles,
  ...troubleshootingArticles,
];

const bySlug = new Map<string, DocArticle>(ALL_ARTICLES.map((a) => [a.slug, a]));

export function getArticleBySlug(slug: string): DocArticle | undefined {
  return bySlug.get(slug);
}

/** `/documentation/[category]/[slug]` route for an article — every article's slug is `<categoryId>/<tail>`. */
export function articleHref(article: DocArticle): string {
  const tail = article.slug.slice(article.category.length + 1);
  return `/documentation/${article.category}/${tail}`;
}

export function getArticlesByCategory(category: DocCategoryId): DocArticle[] {
  return ALL_ARTICLES.filter((a) => a.category === category);
}

export function getRelatedArticles(article: DocArticle): DocArticle[] {
  if (!article.related) return [];
  return article.related.map((slug) => bySlug.get(slug)).filter((a): a is DocArticle => Boolean(a));
}

/** Previous/next article within the same category, in registry order. */
export function getAdjacentArticles(article: DocArticle): { prev: DocArticle | null; next: DocArticle | null } {
  const siblings = getArticlesByCategory(article.category);
  const idx = siblings.findIndex((a) => a.slug === article.slug);
  return {
    prev: idx > 0 ? siblings[idx - 1] : null,
    next: idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null,
  };
}
