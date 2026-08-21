# ADR 0009 — AI assistant: controlled tool layer, not a chat LLM

## Status
Accepted (2026-08-21)

## Context
The brief lists example questions ("Combien ai-je vendu ce mois-ci ?",
"Quel est mon bénéfice net ce mois-ci ?", etc.) and is explicit: the AI
must not invent answers, and must query structured application data
through controlled tools/functions rather than being given unrestricted
database access.

## Decision
`src/lib/ai/tools.ts` implements exactly that controlled tool layer: seven
async functions (`toolRevenueThisMonth`, `toolNetProfitThisMonth`,
`toolBestSellingProduct`, `toolMarketingSpendThisMonth`,
`toolLowStockProducts`, `toolLateOrders`, `toolRepeatCustomers`), each
running one specific, typed Prisma query and formatting the real result as
a French sentence. `runAiToolAction` (a permission-gated Server Action,
requires `ai.use`) dispatches to one of these by a fixed `toolId`, logs an
`ai.query` audit event, and returns the answer. The Assistant IA page
presents the seven questions as buttons — there is no free-text input, so
there is no prompt-injection surface and no possibility of the "assistant"
answering something it wasn't asked to answer.

**There is no LLM call anywhere in this phase.** This is the deterministic
foundation an LLM would call as function tools once a provider is
connected (`IntegrationProvider.AI_PROVIDER`, currently unconfigurable —
see `docs/adr/0004-integration-architecture.md`) — not a placeholder chat
UI pretending to be one. The page copy says this explicitly: "Réponses
basées sur des requêtes contrôlées... L'intégration d'un fournisseur IA
conversationnel est prévue pour une phase ultérieure." This was a
deliberate choice over building a fake/mocked chat interface, which would
violate the brief's "no fake integrations" instruction just as much as a
fake WooCommerce connection would.

## What a future LLM integration would add, not replace
When an `AI_PROVIDER` integration exists, the natural next step is an LLM
that takes a free-text question, matches it to one of these (or new) tool
functions via function-calling, and composes the tool's factual output
into a conversational answer — the LLM still never queries the database
directly or invents numbers; it only orchestrates calls to
`src/lib/ai/tools.ts`-style functions. Each new tool added for that phase
should follow the same shape: one Prisma query, one real number, one
French sentence, no interpretation or extrapolation the underlying data
doesn't support.

## Deferred (explicitly, not silently)
- **LLM provider connection and free-text question answering.**
- **Additional tools** for questions not in the brief's example list
  (e.g. "quels clients n'ont pas commandé depuis 3 mois" — needs a defined
  inactivity threshold, which is exactly the kind of undefined business
  rule ADR 0002 already declined to invent for customer segmentation).
