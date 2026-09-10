# Contributing to ASODITECH

## Documentation is part of the product

ASODITECH ships an in-app Documentation/Demo Center at `/documentation`, generated from and version-controlled with the code. It is not an afterthought and it is not optional.

> **Any user-facing feature change is incomplete until its Documentation/Demo entry has been created or updated.**

This applies whenever a change touches:

- a route or page
- a module or workflow
- a permission or role
- a user-facing action (a new button, a new form, a new bulk operation…)
- an integration (WooCommerce, Shopify, a delivery carrier, Google Drive…)
- an error or validation message shown to a user
- a setting
- a status/enum a user can see
- a business rule that changes what a user should expect

If your change doesn't touch any of the above (a pure refactor, an internal-only helper, a test), no documentation change is needed.

## Where documentation lives

```
src/lib/docs/
  types.ts          the DocArticle / DocBlock / TroubleshootingEntry / GuidedTour shapes
  categories.ts     the 14 top-level sections
  registry.ts       aggregates every content/*.ts file — ALL_ARTICLES
  role-paths.ts      per-role "where do I start" reading order
  guided-tours.ts    the interactive step-by-step demos
  search.ts          the in-browser search scorer
  content/*.ts       one file per category — this is where you add/edit articles
```

Documentation is plain typed TypeScript data (`DocArticle` objects), not Markdown/MDX and not database rows — it is reviewed in the same PR as the code it documents, by the same reviewers, under the same type checker.

## How to add or update an article

1. Open the `content/*.ts` file for the relevant category (or add a new category to `categories.ts` + `types.ts`'s `DocCategoryId` if genuinely none fits).
2. Add or edit a `DocArticle` object. Follow the existing shape: `tagline` ("à quoi ça sert ?"), `prerequisites`, `steps`, `whatYouShouldSee`, `commonMistakes`, `troubleshooting`, `related`, `tryNow`, `lastUpdated`.
3. **Never invent behavior.** Every fact, every error string, every permission name must trace back to real code. If you're documenting a new error message, quote it verbatim — don't paraphrase.
4. If your change adds a genuinely new top-level route, add it to `NAV_GROUPS` in `src/components/layout/sidebar-nav.tsx` (as you already would) **and** give at least one article a `tryNow.href` that points at it.
5. If your change removes or renames a route, update or remove the article(s) whose `tryNow.href` pointed at it.

## The guardrail

`tests/lib/docs-coverage.test.ts` reads the real `NAV_GROUPS` (the single source of truth for every nav-accessible route) and asserts every href has at least one documentation article linking to it via `tryNow`. **A new route with no documentation fails `npm test` by name.** This cannot catch missing *prose quality*, but it cannot be silently bypassed either — that's the point.

`tests/lib/docs-registry.test.ts` additionally catches duplicate slugs, dangling `related` links, and invalid `permission`/`category` values — the kind of drift that accumulates silently otherwise.

Run `npm test` before opening a PR that touches anything in the list above.
