# ADR 0014 — UI design system (visual redesign)

## Status
Accepted (2026-09-01)

## Context
The dashboard shipped on a stock shadcn/base-ui "new-york" component set —
compact (32px inputs/buttons), blue accent, hairline overlays. The owner
asked for a **visual-only** redesign toward a "modern + clean + premium +
tech SaaS" language (reference: demo.nextadmin.co, studied for principles
not copied), with the accent colour tied to the ASODITECH preloader so the
loading screen and the app read as one system.

**Hard constraint: no behaviour change.** No routes, Server Actions,
queries, Prisma, validation logic, or component prop contracts were
touched — only `className`s, design tokens, and additive optional props
(`Button loading`, `Label required`).

## Decision

### 1. Accent = the preloader orange
`src/components/preloader/` and the login button use `#ff8a3d` /
`#ffb238`. `--primary` / `--ring` / `--sidebar-primary` are now
`oklch(0.705 0.174 47.5)` in light (≈ `#f9812f` — the brand orange
deepened just enough for legible white-on-orange button labels) and
`oklch(0.74 0.165 52)` in dark (lifted, with a deep-brown `--primary-
foreground` so the label stays readable). It carries **primary buttons,
focus rings, active/selected states, links, the sidebar active-item
indicator, progress bars, and the branded scrollbar**. `--accent` /
`--sidebar-accent` became a warm 50-tint for hover/selected surfaces.
**Chart colours stay on the cool analytics scale** — data-viz, not
interactive chrome.

### 2. Tokens (`src/app/globals.css`)
| Token | Change |
| --- | --- |
| `--primary`, `--ring`, `--sidebar-primary`, `--sidebar-ring` | blue → brand orange (both themes) |
| `--accent`, `--accent-foreground`, `--sidebar-accent` | blue-tint → warm-tint |
| `--input` | a hair stronger than `--border` so fields read as fields |
| `--radius` | unchanged (`0.5rem`) — controls stay `rounded-lg`, cards/dialogs `rounded-xl` |
| `--shadow-card` / `--shadow-popover` / `--shadow-modal` | **new** — a 3-step elevation scale (near-flat card → lifted popover → floating modal), soft and cool-tinted |

### 3. Controls — taller, calmer, one focus language
- **Input / Textarea / SelectTrigger**: 32px → **40px** (`h-10`; `sm` =
  36px), `px-3`, `bg-background` + `shadow-xs`, 1px `--input` border that
  **warms on hover** (`border-ring/45`) and lifts to a 2px orange ring on
  focus (`ring-ring/25`, from the old 3px `/50`). Disabled is now a
  **distinct** state (`bg-muted` + muted text + no shadow), not just
  `opacity-50`. `aria-invalid` → red border + red ring.
- **Button** (`src/components/ui/button.tsx`): default 32px → **36px**
  (`sm` 32, `xs` 28, `lg` 40, `icon` 36). `default` = solid brand orange
  with a faint coloured shadow; `secondary` grey; `outline` / `ghost` warm
  on hover; **`destructive` is now solid red** (was a soft tint) to match
  the "this is irreversible" weight; `link` unchanged. New optional
  **`loading`** prop → inline spinner + `disabled` + `aria-busy`.
- **Checkbox / Switch**: 40px-family focus ring, orange checked state
  (already token-driven), slightly larger hit target.

### 4. Overlays — a real elevation, restrained motion
- **Dialog / AlertDialog**: backdrop `black/10` → **`black/45` + 3px
  blur** (proper modal focus); content gets **`shadow-modal`** +
  `ring-border` (was a hairline `ring-foreground/10`), padding 16 → 24px,
  title `text-[15px] font-semibold`, `sm:max-w-md`. The footer keeps its
  tinted `border-t` strip. Enter/exit stays fade + 95→100% zoom, ~150ms.
- **Dropdown / Popover / Select content / Command / Sheet**: `shadow-md`
  → **`shadow-popover`**, `ring-border`, item padding normalised to
  `px-2 py-1.5`, `data-highlighted` / `focus` → warm `accent` surface.
- **Tooltip**: unchanged dark chip + a soft shadow.

### 5. Data surfaces
- **Card**: **`shadow-card`** + `ring-border`, padding 16 → 20px, title
  `text-[15px] font-semibold`, footer tint `muted/40`.
- **Table**: header row `h-11`, cells `px-4 py-3` (from `p-2`), header
  text `text-[13px] font-semibold text-muted-foreground` (sentence case,
  not uppercase), row divider `border-border/60`, row hover `muted/40`,
  selected row → `accent`.
- **Badge**: solid → **soft tinted pill** in every variant — `default`
  reads as the brand-orange "active / positive" chip, so a table full of
  status badges stays calm. `rounded-full`, `h-5.5`.

### 6. New helpers (additive, optional)
- `src/components/ui/field.tsx` — `Field` / `FieldRow` / `FieldHint` /
  `FieldError` for a consistent label→control→message rhythm
  (`space-y-2`). `FieldError` renders nothing for an empty message, so a
  possibly-undefined error passes straight through.
- `DialogBody` — a `grid gap-4` body wrapper.
- `Label` gains `required` → appends a subtle red asterisk.

### 7. What changed at call sites
Because the primitives carry the design, most pages update for free. The
only feature files touched are cosmetic: `kpi-card.tsx` (`primary` tone →
brand orange), `login-form.tsx` (bespoke gradient button → standard
primary `loading` button; `space-y-1.5` → `space-y-2`; `required` labels).
Everything else — every form, dialog, table, dropdown across
Orders / Products / Customers / Inventory / Delivery / Finance /
Marketing / Users / Integrations / Settings — inherits the new language
from the shared components.

## Non-goals / not touched
Server code, data flow, permissions, the preloader animation, the
scrollbar (already brand-orange from a prior pass), chart palettes, page
routing/structure.
