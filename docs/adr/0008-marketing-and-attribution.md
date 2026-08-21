# ADR 0008 — Marketing model and attribution honesty

## Status
Accepted (2026-08-21)

## Context
The brief asks for channels, campaigns, spend, leads, conversions,
attributed orders, revenue, ROAS, CAC — while also explicitly warning: no
fake API integrations, and if attribution data is incomplete, show that
it's incomplete rather than presenting a computed-looking number.

## Decision
`MarketingChannel` (Meta / Google / TikTok / Autre) and
`MarketingCampaign` (budget, spend, status, dates) are real, fully
functional CRUD — channels and campaigns are genuinely useful to track
manually even with zero ad-platform integrations, so this much is built
completely rather than stubbed.

`Order.campaignId` (nullable) lets staff manually attribute an order to a
campaign. This is the **only** attribution mechanism that exists. There is
no automatic attribution (UTM parsing, pixel tracking, ad-platform
conversion API) — building that without a live Meta/Google/TikTok
connection would be fake. The Marketing page's campaign table shows
`_count.orders` (manually attributed order count) and explicitly shows
"Non calculable" for ROAS unless both spend and attributed-order data
exist, and even then labels it "Données d'attribution incomplètes" rather
than presenting a manually-attributed subset as a true ROAS — manual
attribution by staff is necessarily incomplete (customers who don't
mention how they found the store won't get attributed), so a computed
ROAS/CAC from this data would overstate precision it doesn't have.

## Deferred (explicitly, not silently)
- **Any ad-platform API connection** (Meta/Google/TikTok spend import,
  conversion reporting). See `docs/adr/0004-integration-architecture.md`.
- **Automatic attribution** (UTM capture at order creation, pixel/conversion
  tracking).
- **CAC calculation.** Requires both reliable spend-per-channel and a
  trustworthy new-customer count per channel — neither exists without ad
  platform data.
- **Rolling marketing spend into the Finance page's expense total** — see
  `docs/adr/0007-finance-and-profit.md`'s deferred section. `spend` lives
  on `MarketingCampaign`, not as an `Expense` row, so double-entry (a
  "Publicité" `Expense` *and* a `MarketingCampaign.spend` for the same
  money) is possible today if a user enters both. This is a known rough
  edge to resolve when marketing spend is wired into finance totals.
