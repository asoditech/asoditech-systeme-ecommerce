# Soft UI redesign — progress

Branch `redesign/soft-ui`, created from `feat/multi-tenant-foundation` @ `363c3c8`
(safety tag `pre-redesign-backup` → `363c3c8`). Visual layer only: no business
logic, API, schema, server action, route, permission or French copy changes.
References: `design-reference/` (untracked, local only).

## Steps

| Step | Scope | Status |
| --- | --- | --- |
| 0 | Git setup, codebase summary | Done |
| 1 | Tokens, Inter font, global CSS, floating shell, sidebar, topbar | Done |
| 2 | Shared components (cards, buttons, inputs, pills, tables, dialogs) | Done |
| 3 | Dashboard (`/tableau-de-bord`) + chart tokens | Done |
| 4 | Commandes (`/commandes`, detail, nouvelle, order dialogs) | Done |
| 5a | Ventes: nouvelle opération, ventes magasin, confirmation, clients, livraison, suivi, retours colis | Done |
| 5b | Catalogue: produits, catégories, stock, réceptions, fournisseurs, traçabilité, transferts, inventaires, entrepôts | Done |
| 5c | Finance & analytics: finance, dépenses, commissions, rapports (12), analyses (6) + charts on the shared chart settings | Done |
| 5d | Settings & others: paramètres (5), utilisateurs, intégrations, marketing, notifications, journal-audit, assistant-IA, documentation, scan (+ shell bits: support widget, announcement badge) | Done |
| 5e | Public/auth: connexion, mot de passe oublié, réinitialiser, invitations, accès refusé, accès plateforme (home `/` only redirects) | Done |
| 6 | Polish: tablet layout, leftover sweep, dead styles, dark-mode pass, final checks | Done |

## Pages

- Done (shell + shared components): every page in the app area gets the new shell, sidebar, topbar and the restyled shared components (buttons, inputs, selects, cards, tables, pills, pagination, tabs, menus, dialogs, toasts…).
- Pages fully redesigned: `/tableau-de-bord` (Step 3); `/commandes`, `/commandes/[id]`, `/commandes/nouvelle` + order dialogs (Step 4 — the reference pattern for table pages); Ventes group (Step 5a): `/operations/nouvelle`, `/ventes` (+ detail, nouvelle), `/confirmation` (+ performance), `/clients` (+ detail, nouveau), `/livraison` (4 tabs), `/livraison/suivi` (+ detail), `/livraison/retours` (+ inspection), `/livraison/factures` (+ invoice); Catalogue group (Step 5b): `/produits` (+ detail, nouveau, exporter, étiquette), `/catalogue/categories`, `/stock`, `/receptions` (+ detail, nouveau, modifier), `/fournisseurs` (+ detail), `/tracabilite`, `/transferts` (+ detail, nouveau), `/inventaires` (+ detail, nouveau), `/entrepots`; Finance & analytics (Step 5c): `/finance`, `/depenses`, `/commissions` (+ agent, relevé), `/rapports` + 11 reports, `/analyses` + 5 tabs; Settings & others (Step 5d): `/parametres` (configuration, notifications, abonnement, canaux, sauvegarde), `/utilisateurs`, `/integrations`, `/marketing`, `/notifications`, `/journal-audit`, `/assistant-ia`, `/documentation` (+ catégorie, article, démo), `/scan/[token]`. « catalogue » and « opérations » of this group were done in 5b (`/catalogue/categories`) and 5a (`/operations/nouvelle`); Public / auth (Step 5e): `/connexion`, `/mot-de-passe-oublie`, `/reinitialiser-mot-de-passe/[token]`, `/invitations/[token]`, `/acces-refuse`, `/acces-plateforme` (the home page `/` is a redirect, nothing to draw).
- Page-specific layouts and colours not restyled yet: all other pages (Steps 4–5).
- Review page: `/dev/components` (dev only, 404 in production builds, not linked).
- Out of scope until decided: `src/app/platform/*` (platform admin), not touched.

## Step 1 — what changed

- `globals.css`: Soft UI tokens (light, dark, `.force-light`), radii (shell 32, card 24, tile 16, control 14), soft shadows, neutral scrollbars, tree-collapse animation (reduced motion respected), print rules for the new shell.
- Font: Inter via `next/font`, chosen in one place only (`src/app/layout.tsx`, `uiFont`), replacing Montserrat.
- Shell: grey page, white rounded shell (full-bleed on mobile), content column is the scroll container.
- Sidebar: 272px / 72px rail; neutral active pill (not orange); collapsible sentence-case groups; « sections » variant kept (cookie) with tree connectors and hover popovers in rail mode; bottom block: Centre d'aide, Clair/Sombre segmented control, Réduire.
- Topbar: search field with ⌘K, orange « Nouvelle opération » (only with `orders.create` or `sales.create`), round icon buttons, avatar menu, no border.
- Mobile: icon logo, compact buttons; theme switch and Centre d'aide moved into the drawer.
- New components: `NavBadge` (pastel count chip, not wired to data), `ThemeSegmented`.
- Theme mechanism unchanged (`dark` class + localStorage `theme`); `setTheme` added to the provider.

## Step 2 — what changed

- Tokens (`globals.css`): `--brand-foreground` = THE text colour on the orange (one place); input border `#E8E8E8` (`--field-border`); pastel pill pairs `--pill-*-bg/-fg` (light + dark, all ≥ 5.7:1); segmented track/thumb, row hover, solid destructive red. `.force-light` now shares the complete light token set with `:root`.
- `ui/*`: Button (44px, 14px radius, round icon sizes; secondary = neutral fill, outline = white pill), Input / Textarea / NativeSelect / Select (44px, #E8E8E8, soft orange focus ring), Badge (pastel pills + new additive `purple` variant), Card (24px, no border; optional `accent` bar on `CardTitle`), Table (no header fill, normal-case muted header, hairline rows, ~64px rows, row hover, opt-in `data-row-actions` hover reveal), Tabs (neutral ink underline; `default` = segmented), SegmentedControl, Dropdown / Select / Popover (16px radius), Dialog / AlertDialog (24px), Sheet (floating right drawer on ≥ sm), Tooltip (dark chip), Toast, Checkbox / Switch (orange when on), Skeleton, Progress, Command, Label / Field.
- App components: PageHeader (32px title), KpiCard (pastel icon chip, 28px value, pastel trend pill), StatusBadge (+ purple), EmptyState, DataTablePagination (pill buttons + 10 | 50 | 100 segmented), DateRangeFields / DateRangeFilter. FilterSelect inherits the Select styles.
- Status colours (`ORDER_STATUS_LABELS`, colour only): Nouvelle blue, Emballage peach, Confirmée / Livrée green, Expédiée purple, Annulée / Retour / Échec red; En attente grey, partial payment yellow. `TONES.badge` uses the pastel pills.
- Props: all unchanged; only optional additions (`CardTitle accent`, Badge `purple`).
- Test updated: `tests/lib/tracking-table.test.ts` asserted the old emerald class; it now asserts the green pill (same intent).

## Step 3 — what changed

- Tokens: muted text `#707070` (4.6:1 on the grey content, 4.9:1 on white); input hover border `#D4D4D4`.
- Chart palette in ONE place: `--chart-1…5` (orange, blue, green, purple, yellow), `--chart-bar` / `--chart-highlight`, grid, axis, cursor, track and dark tooltip tokens (light + dark) in `globals.css`; recharts props in `src/lib/design/chart.ts` (`CHART_COLORS`, `CHART_BAR_RADIUS` = 8, `CHART_GRID_PROPS`, `CHART_AXIS_PROPS`, `chartTooltipProps()`).
- Dashboard (`src/app/(protected)/tableau-de-bord/page.tsx`): bento layout — overview card + « Meilleures ventes » side card (≥ xl), KPI tiles, wide revenue chart card, stock donut, operations, activity lists; pastel bar before every card title (one colour per card type); period filters as dropdown pills (`FilterDropdownPill`, same URLs); no uppercase labels. Data fetching, calculations, permissions and French copy unchanged (render conditions diffed against the original).
- Charts: revenue trend = rounded pastel bars with the peak bucket highlighted in orange (the same « Pic » named above it); hero sparkline = smooth orange line; « Stock physique » = donut with rounded caps (same three figures); dark tooltip chip.
- Components: `CommandHero` (plain card, 48px figure, pastel stat chips), `KpiCard` new optional `size="lg"` (40px figure), `SummarySection` (sentence case — also on the 4 other pages using it), `MetricBreakdown`, `RankedMetricList`, `Sparkline`, `MissingCostBanner` (pastel yellow).
- New: `src/components/filter-dropdown-pill.tsx`, `src/components/dashboard/stock-donut.tsx`, `src/app/(protected)/tableau-de-bord/loading.tsx` (bento skeleton, also shown on `/dev/components`).

## Step 4 — what changed

- New shared pieces (additive, no prop changes): `TableCard` (`ui/table.tsx`, the white 24px card a list table + its pagination sit in, 24px edge padding), `FilterBar` / `FilterChip` (`components/filter-bar.tsx`), `Notice` (`ui/notice.tsx`, the ONE callout: warning / danger / success / info / neutral / hint on the pill tokens — replaces `border-amber-500/30 bg-amber-500/10 …` boxes), `text-link` utility in `globals.css` (ink link, underline on hover — orange text is below AA).
- `/commandes`: filter bar (search full width on mobile, status/payment side by side), table in `TableCard`, order number 15px semibold as anchor, date · items muted, ink-secondary channel/agent, row menu `data-row-actions` (revealed on row hover/focus, always visible on touch), agent filter as `FilterChip`.
- `/commandes/[id]`: pastel accent bars instead of icons on card titles (peach = articles, purple = logistics, blue = people, green = money, yellow = notes/history), right-aligned tabular amounts, larger total, `Notice` for packing states, tokens for warn/success text, mobile overflow fixed (`min-w-0` grid columns), lifecycle stepper restyled (orange dot + peach halo, 2px rounded connector, 12px labels).
- `/commandes/nouvelle` (`OrderForm`): peach step numbers, Notice for city guidance and blacklisted client, neutral « Clients récents » label (no uppercase), switch tile, summary tile, ink checks/links.
- `FormSection` title: sentence case 14px (was 11px uppercase) — shows on every form using it.
- Dialogs: purge (neutral summary tile, no uppercase, danger Notices), status change stock notice, edit address, stock override (now uses `Textarea`), shipment cost override, packing panel; `ProductChips` = neutral pills; `PhoneActions` WhatsApp = round green pill; `DisconnectedSourceBanner` = warning Notice.

## Step 5a — Ventes

- Shared: `StatChip` (`components/filter-bar.tsx`) — the white counter pill of the Suivi / Retours status strips (was two page-local copies); `FilterSelect`s in filter bars are full-half-width on mobile and content-sized on desktop (`sm:w-auto sm:min-w-*`, labels no longer clipped — also on `/commandes`); `.dark { color-scheme: dark }` so native number spinners / date pickers follow the theme.
- Every list: `FilterBar` + `TableCard`, order / sale numbers as the 15px semibold anchor, ink / muted text tokens, page-level buttons at the default 44px.
- `/operations/nouvelle`: two choice cards with round pastel icon chips, shadow on hover, focus ring, ink « Créer … → » link (orange text removed).
- `/ventes/[id]` + `/ventes/nouvelle` (`SaleForm`): accent bars (blue = point de vente, peach = articles, green = paiement, purple = retours), larger ink total, `Notice` for « Reste à encaisser », hairline line lists, neutral chosen-client pill.
- `/confirmation`: tabs as `SegmentedControl` (same links), queue cards = white cards, WhatsApp = green pill, stock warning = `Notice`, confirmed lists = card rows; « Mes confirmations » hero figure in ink (no green text). `/confirmation/performance`: explanation as a neutral `Notice`, conversion bar on the chart tokens.
- `/clients/[id]`: blacklist / cancelled-orders banner = `Notice` (danger / warning).
- `/livraison`: shipments + providers in `TableCard` (dense columns kept so the 9-column table still fits at 1280), docs panels as cards, Aramex warning = `Notice`. `/livraison/suivi` + detail: accent bars instead of icons, `Notice` for sync errors, ink link to the carrier. `/livraison/retours` + inspection: `StatChip` strip, tiles on tokens. Invoice sheet keeps its printed-paper look (white, slate) — only the uppercase title removed.
- Colour tokens: emerald / amber / sky text → `text-pill-*-fg` (AA in both themes); `text-[10px]` / `text-[11px]` → 12px; `text-muted-foreground/70` → `text-ink-muted`.
- Checked: light 1280, dark 390, light 768 on all 21 URLs (no horizontal overflow); dialogs in dark: sale return, provider pricing, provider connection, blacklist, cancel reception.

## Step 5b — Catalogue

- Shared: `PageHeader` actions now wrap (no more clipped buttons on phones — e.g. product detail); `SyncRefreshButton` default size = the 44px button (it only sits in page headers); `MetricWithProgress` (round pastel chip, ink figure, bars on `chart-track` / brand); `EntityAvatar` = round peach chip; `LocationCostDisplay` « coût emplacement » in peach ink (orange text removed); product export platform switch = segmented thumb.
- Lists (`/produits`, `/stock`, `/receptions`, `/fournisseurs`, `/transferts`, `/inventaires`, `/entrepots`, `/catalogue/categories`): `FilterBar` + `TableCard`, ink names (no orange hover), mobile-first filter widths; page-level buttons at 44px.
- Detail pages: accent bars on every card title (peach = articles / images / codes, purple = itinéraire / emplacements / réception / canaux, green = paiements / coûts, yellow = notes / historique / suivi); « Rentabilité » on the product page is a `SummarySection` (its KPI tiles no longer sit inside another card) with the cost explanation as a neutral `Notice`; amber boxes (missing stock per variant, remote link, traceability cost) → `Notice`; inventory / transfer detail grids get `min-w-0` columns (fixed a 390px overflow).
- Supplier balance bar: paid = success green, remaining = chart yellow.
- Printable label keeps its print look (black on white); only its on-screen status lines use the token colours.
- Checked: light 1280, dark 390, light 768 on 21 URLs (no overflow after the two fixes above); dialogs in dark: new location (1280 + 390), remove product, cancel transfer.

## Step 5c — Finance & analytics

- Charts: `SeriesChart` (analyses) and `SalesChart` (rapport de ventes) now take grid, axes, tooltip (dark chip) and bar radius from `src/lib/design/chart.ts`; series colours come from new meaning keys `CHART_COLORS.brand / neutral / positive / negative / attention / secondary` (no more hex values in pages). Narrow grouped bars use `CHART_BAR_RADIUS_DENSE` (a radius wider than the bar collapsed it into a hairline). CSS bar lists (`BreakdownBarList`, `FunnelBars`) use `CHART_BAR_CLASSES` (same palette as classes) on the chart track.
- Shared: `PageHeader` lets wide actions wrap onto their own line (the title column keeps ≥ 18rem) — fixes the squeezed description on `/finance`; analyses explanation-language toggle on the segmented tokens.
- Toggles that were orange-filled buttons are now `SegmentedControl`s with the same links: `/finance` period, `/depenses` period, `/rapports/canaux` online/store + store pickers, `/rapports/profitabilite` product/campaign view. « Ce mois-ci » on `/depenses` = neutral pressed button.
- Every report / analysis card title has an accent bar by subject (green = money, blue = people / confirmation, peach = products / stock / returns, purple = delivery / channels); links that were orange text use `text-link`; commission and supplier balance bars on success / chart yellow; dormant stock rows = pale yellow; « nouveau » client tag = blue pill; statement sheet keeps its paper look.
- Commissions: « Ajouter un agent » and agent rate forms wrap instead of overflowing at 390 / 768.
- Checked: light 1280, dark 390, light 768 on 21 URLs (no overflow after the fix above); charts scrolled into view in light and dark; dialogs in dark: new expense (1280 + 390), edit expense.

## Step 5d — Settings & others

- No uppercase label left in the app (`grep uppercase` = only `src/app/platform`, out of scope): settings legends / column heads, docs « Sur cette page », support widget headings, control-centre eyebrow, announcement « Nouveau » tag.
- Settings: tab nav = ink underline on a hairline (was orange); configuration « Centre de contrôle » = plain card, completion ring on brand / success, stat chips and section accents (`config/section-meta.ts`) on the pastel pill pairs (same keys, same icons — no more indigo / teal / sky / violet scale), section switcher = segmented pills, « à corriger » tiles = pale yellow with yellow rail, setting cards = 24px cards, radio tiles = hairline tiles with a brand check.
- Docs: `Callout` is now the shared `Notice` (same tones); sidebar active item = neutral nav pill (was peach + orange rail); guided tour progress on brand / chart track; card titles with accent bars.
- Integrations / notifications: status dots on success / chart yellow; « actif » chips = green pills; error boxes = red tiles; « Bientôt disponible » cards = dashed hairline. Notification list = one card with hairline rows, unread rows faint peach, date + dismiss stack on phones (fixed a 390px overflow).
- Users: permission override switch (Hérité / Autoriser / Refuser) = segmented pills (neutral / green / red); checkbox rows = hairline tiles.
- `/scan/[token]` (public scan page): page background + 24px card.
- Checked: light 1280, dark 390, light 768 on 16 URLs (no overflow after the fix above); dialogs in dark: invite user (1280 + 390), new marketing channel.

## Step 5e — Public / auth

- `AuthShell` (props unchanged): always-light grey page, one white 32px card with the shell shadow, 24px title — the three hard-coded colour blobs and the frosted-glass card are gone, and their `blob-breathe` keyframes removed from `globals.css` (dead CSS).
- `/connexion` now renders through `AuthShell` (it carried its own copy of the same markup; same title and text).
- Auth forms: inputs use the shared field style (the per-page `border-black/10 bg-white/70` overrides removed), hairline divider, contact buttons = white round chips.
- `/acces-refuse`: centred card with a red pastel icon chip and a full-width button.
- Checked: logged out at 1280 light (connexion, mot de passe oublié, réinitialiser / invitation / scan with an invalid token) and 390 (connexion, invitation — always light by design); `/acces-refuse` at 390 dark.

## Step 6 — polish

- Tablet layout: below 1024px (`lg`) the sidebar is hidden and the existing drawer (hamburger + icon logo in the topbar) takes over — at 768px the content now uses the full width. Same navigation, permissions and collapse cookie; only the breakpoint moved from `md` to `lg`. Topbar « Nouvelle opération » no longer wraps.
- Leftover sweep (grep + screenshots): no uppercase label in the app; last orange fills / orange text moved to tokens (selected order-line chips, usage and sync bars, explanation links); hard-coded hex moved to tokens where a token exists (avatar fallback, tooltip chip → chart tooltip tokens, skeleton → segment track, switch off-state → field border); 10–11px text raised to 12px (KPI trend pill, ranked list, notification menu, footer, order-form badge); panels on the 16px tile radius; faded `text-muted-foreground/70–90` → `text-ink-muted` (AA).
- Dead styles removed: the unused `bar / text / surface / ring` entries of `TONES` (`src/lib/design/tone.ts`), the unused `.no-scrollbar` utility (and the login blob keyframes in 5e).
- Kept on purpose (documented, not leftovers): printed documents (delivery invoice, commission statement, report print header, product label) stay black-on-white paper; camera scanner overlays stay black; dialog scrims `bg-black/30`; WhatsApp brand green; `global-error.tsx` inline colours (it renders without the app CSS); the announcement bar's solid colours (pinned by `platform-announcements.test.ts`); `NavBadge` dark text on pastel (pinned by `nav-badge.test.ts`); the lifecycle stepper's 11px dates (narrow columns).
- `/dev/components`: verified 404 on a production server (`next start`).
- Dark mode: 84 URLs captured at 1280 dark (no horizontal overflow) and reviewed as contact sheets; dialogs in dark this step: stock adjustment, user access, user locations, password reset; mobile drawer at 768 dark.
- Separate fix commits (not redesign): `fix(top-progress-bar)` and `fix(theme)` (a `notFound()` page ignored the stored dark theme — ThemeProvider now re-applies the same rule on mount).

## Decisions (confirmed by the owner after Step 1)

- AA contrast: muted text is `#707070` (switched from `#767676` after Step 2; `#9A9A9A` kept as `--text-faint`, decoration only); primary-button text is dark `#1f1206` on orange (white is 2.8:1), set once as `--brand-foreground`; focus ring uses `#D96F2D`.
- New labels « Clair » / « Sombre » and « Nouvelle opération » (topbar button linking to the existing `/operations/nouvelle`).
- Sidebar hover-preview (expand on hover when collapsed) replaced by the rail with tooltips/popovers.

## Known issues

- Pre-existing, left on purpose: `/clients/[id]` logs « Only plain objects can be passed to Client Components… Decimal » in dev (a Prisma `Decimal` reaches a client component) — a data-handling change, separate task.
- Pre-existing: some percentages print « 100.0 % » (dot) next to « 100,0 % » (comma) — number formatting, not changed.
- Announcement bar « Nouveauté » = white text on the orange (≈ 2.8:1, below AA); colours are pinned by a test as a product decision — owner to decide.
- Input border `#E8E8E8` (requested) is below the 3:1 non-text contrast guideline; the label, focus ring and error state carry the meaning.
- Between 1024 and 1279px the full 272px sidebar stays open (wide tables scroll inside their card); it can still be reduced to the rail with « Réduire ».
- `NavBadge` not connected to counts (by decision: no new queries).
- Full test suite: DB-backed tests can time out when the machine is busy (seen in the baseline and 5a runs) and pass alone; the final run is done with nothing else running.
- Not verified on local data (no safe way to create and remove it — tenant row-level security, no delete in the UI for marketing, real financial records for statements / shipments), to check by hand:
  - « Créer une expédition » dialog (`/livraison` → À expédier, needs a confirmed order without shipment) and the city-mapping dialog (needs an API carrier with city lookup);
  - « Nouvelle campagne » (`/marketing`, needs a marketing channel) and `/rapports/profitabilite/campagne/[id]`;
  - a commission statement `/commissions/[agentId]/releves/[id]`;
  - `/acces-plateforme` unlock form (needs PLATFORM_ACCESS_KEY_SHA256 — env, not touched);
  - valid password-reset and invitation links (only the invalid-link screens were seen).
