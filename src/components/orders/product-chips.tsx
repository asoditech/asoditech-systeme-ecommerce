import { productChips, type ChipLine } from "@/lib/catalog/product-chips";

export const CHIP = "inline-flex h-6 max-w-[11rem] items-center gap-1 rounded-full bg-pill-neutral px-2.5 text-xs text-pill-neutral-fg";

/** « Produits » column cell: [Basket ×2] [Casquette ×1] [+2] — one line, never a tall row. */
export function ProductChips({ lines, max = 2 }: { lines: ChipLine[]; max?: number }) {
  const { chips, more } = productChips(lines, max);
  if (chips.length === 0) return <span className="text-ink-muted">—</span>;
  const title = productChips(lines, Number.MAX_SAFE_INTEGER).chips.map((c) => `${c.label} ×${c.quantity}`).join("\n");
  return (
    <div className="flex max-w-[20rem] flex-wrap gap-1" title={title}>
      {chips.map((c) => (
        <span key={c.label} className={CHIP}>
          <span className="truncate">{c.label}</span>
          <span className="shrink-0 text-ink-muted">×{c.quantity}</span>
        </span>
      ))}
      {more > 0 && <span className={`${CHIP} font-medium`}>+{more}</span>}
    </div>
  );
}
