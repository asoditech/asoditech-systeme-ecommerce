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
| 3 | Dashboard (`/tableau-de-bord`) + chart tokens | To do |
| 4 | Commandes (`/commandes`, detail, confirmation) | To do |
| 5a/b/c | Remaining page groups | To do |
| 6 | Polish, responsiveness, AA audit | To do |

## Pages

- Done (shell + shared components): every page in the app area gets the new shell, sidebar, topbar and the restyled shared components (buttons, inputs, selects, cards, tables, pills, pagination, tabs, menus, dialogs, toasts…).
- Page-specific layouts and colours not restyled yet: all pages (Steps 3–5).
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

## Decisions (confirmed by the owner after Step 1)

- AA contrast: muted text is `#767676` (`#9A9A9A` kept as `--text-faint`, decoration only); primary-button text is dark `#1f1206` on orange (white is 2.8:1), set once as `--brand-foreground`; focus ring uses `#D96F2D`.
- New labels « Clair » / « Sombre » and « Nouvelle opération » (topbar button linking to the existing `/operations/nouvelle`).
- Sidebar hover-preview (expand on hover when collapsed) replaced by the rail with tooltips/popovers.

## Known issues

- Muted text `#767676` is 4.5:1 on white cards but 4.2:1 on the grey content background (`#F6F6F6`); `#707070` would pass on both — to decide.
- Input border `#E8E8E8` (requested) is below the 3:1 non-text contrast guideline; the label above, the focus ring and the error state carry the meaning.
- Some pages override sizes / colours locally (e.g. `CardTitle className="text-[15px]"`, small « Actualiser » buttons, orange settings tabs): cleaned page by page in Steps 3–5.
- `/dev/components` to be removed or kept dev-only at Step 6.
- Dashboard still shows uppercase section labels and old card styles (Step 3); chart colours unchanged until Step 3.
- `NavBadge` not connected to counts (by decision: no new queries in Step 1).
