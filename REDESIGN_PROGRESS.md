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
| 5a/b/c | Remaining page groups | To do |
| 6 | Polish, responsiveness, AA audit | To do |

## Pages

- Done (shell + shared components): every page in the app area gets the new shell, sidebar, topbar and the restyled shared components (buttons, inputs, selects, cards, tables, pills, pagination, tabs, menus, dialogs, toasts…).
- Pages fully redesigned: `/tableau-de-bord` (Step 3); `/commandes`, `/commandes/[id]`, `/commandes/nouvelle` + order dialogs (Step 4 — the reference pattern for table pages).
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

## Decisions (confirmed by the owner after Step 1)

- AA contrast: muted text is `#707070` (switched from `#767676` after Step 2; `#9A9A9A` kept as `--text-faint`, decoration only); primary-button text is dark `#1f1206` on orange (white is 2.8:1), set once as `--brand-foreground`; focus ring uses `#D96F2D`.
- New labels « Clair » / « Sombre » and « Nouvelle opération » (topbar button linking to the existing `/operations/nouvelle`).
- Sidebar hover-preview (expand on hover when collapsed) replaced by the rail with tooltips/popovers.

## Known issues

- Input border `#E8E8E8` (requested) is below the 3:1 non-text contrast guideline; the label above, the focus ring and the error state carry the meaning.
- Some pages override sizes / colours locally (e.g. `CardTitle className="text-[15px]"`, small « Actualiser » buttons, orange settings tabs): cleaned page by page in Steps 3–5.
- `/dev/components` to be removed or kept dev-only at Step 6.
- Other charts (`/rapports/ventes` sales chart, `/analyses` series chart) still use their own colours: move them onto `src/lib/design/chart.ts` with their pages (Step 5).
- `CommandHero` / `SummarySection` restyle also shows on `/rapports/ventes`, `/confirmation`, `/fournisseurs/[id]`, `/commissions/[agentId]` (shared components) before those pages get their own pass.
- 24 other pages still wrap tables in `rounded-xl border bg-card shadow-card` and ~18 files use the amber callout: moved onto `TableCard` / `Notice` in Step 5.
- Full suite under load: a few DB-backed tests time out (baseline run: 10 in 6 files; Step 4 run: 4 in `analytics.test.ts`) and pass when re-run alone — not redesign-related.
- Pre-existing (not redesign): dev console error « useInsertionEffect must not schedule updates » from `src/components/top-progress-bar.tsx` on client navigation (file untouched since before the redesign).
- `NavBadge` not connected to counts (by decision: no new queries in Step 1).
