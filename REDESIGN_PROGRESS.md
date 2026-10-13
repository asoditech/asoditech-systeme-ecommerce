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
| 2 | Shared components (cards, buttons, inputs, pills, tables, dialogs) | To do |
| 3 | Dashboard (`/tableau-de-bord`) + chart tokens | To do |
| 4 | Commandes (`/commandes`, detail, confirmation) | To do |
| 5a/b/c | Remaining page groups | To do |
| 6 | Polish, responsiveness, AA audit | To do |

## Pages

- Done (shell only, content unchanged): every page in the `(app)` area gets the new shell, sidebar and topbar.
- Content not restyled yet: all pages.
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

## Decisions / deviations to review

- AA contrast: muted text is `#767676` (`#9A9A9A` kept as `--text-faint`, decoration only); primary-button text is dark `#1f1206` on orange (white is 2.8:1); focus ring uses `#D96F2D`.
- New labels « Clair » / « Sombre » and « Nouvelle opération » (topbar button linking to the existing `/operations/nouvelle`).
- Sidebar hover-preview (expand on hover when collapsed) replaced by the rail with tooltips/popovers.

## Known issues

- Dashboard still shows uppercase section labels and old card styles (Step 3).
- Input border token `--input` unchanged until Step 2; chart colours unchanged until Step 3.
- `NavBadge` not connected to counts (by decision: no new queries in Step 1).
