# Cloudflare in front of Vercel — security plan (NOT yet applied)

Status: proposal, 2026-10-03. Nothing below is configured. Cloudflare and
Vercel settings live outside this repository; this document is the exact
configuration to apply, test and roll back. No application code duplicates
Cloudflare features.

Target: `Internet → Cloudflare (WAF, DDoS, bots, rate limiting, geo policy)
→ Vercel → ASODITECH (Next.js) → Supabase PostgreSQL`.

## 0. Decision to make first

Vercel does not recommend a reverse proxy in front of Vercel: it hides
real traffic from Vercel's own firewall/DDoS mitigation, adds a hop, and
complicates caching ([Vercel: using Cloudflare with Vercel](https://vercel.com/docs/integrations/cloudflare)).
Two viable options:

| Option | What you get | Cost / caveats |
|---|---|---|
| **A. Vercel Firewall only** (no proxy) | Vercel DDoS mitigation (all plans), custom rules incl. country, Attack Challenge Mode; rate limiting on Pro | Fewer bot/WAF features than Cloudflare; per-plan limits |
| **B. Cloudflare proxy** (this plan) | Managed WAF rules, bot controls, geo rules, rate limiting, analytics | Vercel visibility loss (above); origin bypass via `*.vercel.app` (§A.4); client IP handling (§A.5); Free plan = 1 rate-limiting rule |

The rest of this document details option B as requested.

## Route inventory (audited 2026-10-03)

Source: `src/proxy.ts`, `src/app/**/route.ts`, `src/app/**/page.tsx`.

| Class | Paths | Callers | Notes |
|---|---|---|---|
| Public auth pages (GET + server-action POST) | `/connexion`, `/mot-de-passe-oublie`, `/reinitialiser-mot-de-passe/<token>`, `/invitations/<token>` | Humans (mostly Morocco) | Login, reset and invitation are **Next.js Server Actions = POST to the page path**. **No application-level rate limiting or lockout exists today.** |
| Platform step-up | `/acces-plateforme` (POST = key check), `/platform/**` | Platform owner only | Session + `isPlatformAdmin` + 256-bit key; failed attempts audited |
| Public QR landing | `/scan/<token>` | Anyone scanning a printed label | Deliberately public |
| Inbound webhooks | `/api/webhooks/shopify`, `/api/webhooks/woocommerce` | **Shopify servers (global), the merchant's WooCommerce host (any country)** | HMAC-verified in code; **must never be geo-blocked or challenged** |
| Carrier webhooks | none exposed | — | `handleDeliveryWebhook` exists but has **no route** today |
| OAuth callback | `/parametres/sauvegarde/google/callback` | User's browser redirected by Google | Needs an existing session |
| Authenticated app | everything else (`/tableau-de-bord`, `/commandes`, …, exports under `/…/export`) | Logged-in users | Session cookie `aec_session` |
| Static / branding | `/_next/static/**`, `/icon.png`, `/apple-icon.png`, `/opengraph-image.png`, `/twitter-image.png`, `/icons/**`, `/manifest.webmanifest`, `/vendor/zxing-wasm-*/**`, `/logos/**` | Browsers, **link-preview crawlers (Meta/WhatsApp, X, LinkedIn, Telegram)** | Must stay reachable worldwide for previews |
| Payments | none | — | No payment routes exist |
| Email (Resend) | none inbound | — | Outbound only (Vercel → Resend API); no Resend webhook route |

Outbound calls (Resend, WhatsApp Graph API, Shopify/WooCommerce APIs,
carriers, Google Drive) leave from Vercel and are **not affected** by
Cloudflare in front of the domain.

## A. DNS / proxy setup

1. Move the `asoditech.com` zone to Cloudflare (full setup: nameservers
   change at GoDaddy). Partial/CNAME setup needs a Business plan.
2. **Before switching nameservers, recreate every existing record** in
   Cloudflare, notably the Resend records (`resend._domainkey` TXT,
   `send` / `rsend` CNAMEs, `_dmarc` TXT) as **DNS only (grey cloud)** —
   proxying them breaks email authentication.
3. Web records, **Proxied (orange)**:
   - `www` → `CNAME cname.vercel-dns.com`
   - apex `asoditech.com` → as currently configured for Vercel (A record or
     CNAME-flattened), redirecting to `www` as today.
4. SSL/TLS mode **Full (strict)** — never "Strict (SSL-Only Origin Pull)"
   and never Flexible (redirect loops, ACME failures). Keep
   `/.well-known/acme-challenge/*` untouched (Full (strict) exempts it from
   Always Use HTTPS) so Vercel can renew its certificate.
5. **Origin bypass (known gap):** the deployment stays reachable at
   `*.vercel.app`, which skips Cloudflare. Phase 2 (requires a code change +
   one Vercel env var, not done): Cloudflare Transform Rule adds a secret
   request header; `src/proxy.ts` rejects production requests without it
   (except Vercel health/ACME paths). Until then, Cloudflare protects the
   public domain, not the origin.
6. **Client IP:** the app stores the first `X-Forwarded-For` hop in sessions
   and the audit journal (`src/lib/auth/session.ts`, `src/lib/audit.ts`).
   Behind Cloudflare, Vercel may record a Cloudflare edge IP instead of the
   visitor's. Verify after the switch; if so, Phase 2 reads
   `CF-Connecting-IP` **only once the origin is locked** (item 5) — trusting
   that header without the lock would let anyone forge their IP.
7. Caching: add a Cache Rule **Bypass cache** for everything except
   `/_next/static/*`, `/vendor/*`, `/icons/*`, `/logos/*` and the image files
   above. HTML, RSC payloads and server actions must never be cached by
   Cloudflare (they are per-user).

## B. WAF strategy

1. Enable **Cloudflare Managed Ruleset** (Pro+) / Free Managed Ruleset,
   action default, and the OWASP Core Ruleset in **log/simulate** first (Pro+),
   then raise to block once false positives are understood.
2. Custom rule order (Security → WAF → Custom rules):
   1. **Skip** for webhooks — `starts_with(http.request.uri.path, "/api/webhooks/")`:
      skip managed rules' bot/geo custom rules below and rate limiting.
      Keep only the managed SQLi/XSS rules if they show no false positives
      on real Shopify/WooCommerce payloads (check Security Events first).
   2. **Skip** for static/branding paths (list in the inventory) — skip the
      geo challenge so link-preview crawlers work.
   3. Geo policy (§G).
   4. **Block** obvious probes: `/wp-admin`, `/wp-login.php`, `/.env`,
      `/.git`, `/phpmyadmin`, `/xmlrpc.php` (this app has none of them).
3. Do **not** enable the Free plan's *Bot Fight Mode*: it cannot be
   bypassed by WAF skip rules and can challenge Shopify/WooCommerce webhooks.
   Use *Super Bot Fight Mode* (Pro+) with a skip for `/api/webhooks/` and
   "Allow verified bots".

## C. Rate limiting

Moroccan mobile carriers use carrier-grade NAT: many users can share one
IP. Thresholds below are deliberately lenient and per IP + path.

Free plan (1 rule, 10-second window) — one combined authentication rule:

```
(http.request.method eq "POST" and (
  http.request.uri.path in {"/connexion" "/mot-de-passe-oublie" "/acces-plateforme"}
  or starts_with(http.request.uri.path, "/reinitialiser-mot-de-passe/")
  or starts_with(http.request.uri.path, "/invitations/")))
```
Characteristics: IP. Threshold: 8 requests / 10 s. Action: Block (or
Managed Challenge on Pro+), duration 1 minute.

Pro/Business (more rules, longer windows), add:
- Login: 20 POST / 10 min per IP on `/connexion` → Managed Challenge 10 min.
- Password reset: 5 POST / 10 min per IP on `/mot-de-passe-oublie` → Block 1 h
  (it sends e-mails: abuse costs Resend quota).
- Platform key: 10 POST / 10 min per IP on `/acces-plateforme` → Block 1 h.
- Exports (`…/export…`, `/produits/exporter/*`): 30 GET / min per IP → Managed
  Challenge (expensive queries).
- Webhooks: no rate limit, or a very high ceiling (e.g. 600 / min per IP) —
  Shopify retries aggressively on failure and a block would lose orders.

## D. Authentication protection

- Rate limiting above (there is no application lockout today).
- Optional Turnstile on `/connexion` and `/mot-de-passe-oublie` would need an
  application change (server-side token verification); not proposed now.
- `/platform/**` and `/acces-plateforme`: Managed Challenge for any country
  other than MA (§G) — never a hard block, the owner may travel.

## E. API protection

The only `/api/*` routes are the two webhooks (HMAC-verified, reject
unsigned requests with 401). Other "API-like" endpoints are Server Actions
(POST to pages, require a session) and CSV exports (GET, require a session
and permissions). Protection = WAF managed rules + rate limiting on
exports; no separate API gateway needed.

## F. Webhook / integration exceptions

- `/api/webhooks/shopify` and `/api/webhooks/woocommerce`: excluded from geo
  rules, challenges, Bot Fight Mode and rate limiting. A challenge returns
  HTML/403 to a server, which silently breaks real-time order sync.
- If a carrier webhook route is added later (`handleDeliveryWebhook`), add
  it to the same exception list.
- Google OAuth callback: comes through the user's browser — no exception
  needed beyond not blocking the user's country.

## G. Morocco geolocation strategy

Do **not** block all non-MA traffic on day one. Staged rollout:

1. Week 1 — observe only: a custom rule matching
   `ip.geoip.country ne "MA"` and not webhooks/static, with action **Managed
   Challenge on `/connexion` only**; review Security Events for real
   customers abroad (MRE customers, staff travelling, VPN users).
2. Week 2+ — Managed Challenge (not Block) for non-MA on all interactive
   pages, still skipping webhooks, static/branding assets and verified bots.
3. Only hard-block specific countries/ASNs that show sustained abuse.
Never geo-block `/api/webhooks/*`, `/_next/static/*`, the OG/icon/manifest
files, or `/scan/*` (printed QR labels may be scanned anywhere).

## H. Not blocking legitimate crawlers and services

- Skip rule for verified bots: `cf.client.bot` (Free) /
  `cf.verified_bot_category` (Pro+) on GET to public pages and branding
  assets — covers Facebook/WhatsApp (`facebookexternalhit`), X, LinkedIn,
  Telegram, Google.
- Shared-link previews only need `/`, `/connexion` (where unauthenticated
  links land), `/opengraph-image.png`, `/twitter-image.png`, icons and the
  manifest.

## I. Safe testing

1. Create rules with **Managed Challenge** (or Log on Enterprise) first; watch
   Security → Events for 48 h before switching to Block.
2. Tests after each change:
   - Login works from Morocco on Wi-Fi and on mobile data (CGNAT).
   - From a non-MA VPN: login shows a challenge, not a block (stage 2).
   - Shopify: trigger a test order → order appears in ASODITECH; Shopify
     admin shows webhook deliveries succeeding. WooCommerce: same.
   - Rate limit: 9 rapid POSTs to `/connexion` from one IP → blocked for
     1 minute; normal login unaffected afterwards.
   - Link preview: Facebook Sharing Debugger / a WhatsApp message shows the
     ASODITECH image and title.
   - `/platform/sante` still loads (Vercel origin reachable, DB check OK).
   - Certificate: Vercel dashboard shows the domain valid after 24 h.
3. Check the client IP recorded in a new session (§A.6).

## J. Rollback

Fastest first:
1. Set the `www` (and apex) records to **DNS only** (grey cloud): traffic goes
   straight to Vercel within the record TTL; all Cloudflare rules stop applying.
2. Or disable individual WAF / rate-limiting rules (instant).
3. Or "Pause Cloudflare on Site" (Overview page).
4. Full rollback: restore the GoDaddy nameservers. Keep an export of the
   GoDaddy zone (incl. Resend records) before the switch; nameserver
   changes can take hours to propagate.
