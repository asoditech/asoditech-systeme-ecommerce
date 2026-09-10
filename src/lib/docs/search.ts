import type { DocArticle } from "./types";

/**
 * In-browser scored search over the doc registry — no search library.
 * The whole corpus is a few hundred short strings, so a simple weighted
 * substring match is instant and needs nothing heavier.
 */

const DIACRITICS_RE = /[̀-ͯ]/g;

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(DIACRITICS_RE, "");
}

export interface SearchResult {
  article: DocArticle;
  score: number;
  /** Which matched troubleshooting entry (if the match came from one), for a focused snippet. */
  matchedSymptom?: string;
}

/** Scores one article against a query; 0 = no match. */
export function scoreArticle(article: DocArticle, query: string): SearchResult | null {
  const q = normalize(query.trim());
  if (!q) return null;

  let score = 0;
  let matchedSymptom: string | undefined;

  const title = normalize(article.title);
  const tagline = normalize(article.tagline);

  if (title === q) score += 100;
  else if (title.includes(q)) score += 50;

  if (tagline.includes(q)) score += 20;

  for (const kw of article.keywords ?? []) {
    const nk = normalize(kw);
    if (nk === q) score += 60;
    else if (nk.includes(q) || q.includes(nk)) score += 30;
  }

  for (const entry of article.troubleshooting ?? []) {
    const symptom = normalize(entry.symptom);
    if (symptom.includes(q) || q.includes(symptom)) {
      score += 40;
      matchedSymptom = matchedSymptom ?? entry.symptom;
    }
    for (const err of entry.errorStrings ?? []) {
      const nerr = normalize(err);
      if (nerr.includes(q) || q.includes(nerr)) {
        score += 45;
        matchedSymptom = matchedSymptom ?? entry.symptom;
      }
    }
  }

  for (const step of article.steps ?? []) {
    if (normalize(step).includes(q)) score += 5;
  }

  if (score === 0) return null;
  return { article, score, matchedSymptom };
}

export function searchArticles(articles: DocArticle[], query: string, limit = 12): SearchResult[] {
  const results = articles
    .map((a) => scoreArticle(a, query))
    .filter((r): r is SearchResult => r !== null)
    .sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
