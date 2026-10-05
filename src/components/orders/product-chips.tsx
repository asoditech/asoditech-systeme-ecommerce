import { productChips, type ChipLine } from "@/lib/catalog/product-chips";

export const CHIP = "inline-flex max-w-[11rem] items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-xs";

/** « Produits » column cell: [Basket ×2] [Casquette ×1] [+2] — one line, never a tall row. */
export function ProductChips({ lines, max = 2 }: { lines: ChipLine[]; max?: number }) {
  const { chips, more } = productChips(lines, max);
  if (chips.length === 0) return <span className="text-muted-foreground">—</span>;
  const title = productChips(lines, Number.MAX_SAFE_INTEGER).chips.map((c) => `${c.label} ×${c.quantity}`).join("\n");
  return (
    <div className="flex max-w-[20rem] flex-wrap gap-1" title={title}>
      {chips.map((c) => (
        <span key={c.label} className={CHIP}>
          <span className="truncate">{c.label}</span>
          <span className="shrink-0 text-muted-foreground">×{c.quantity}</span>
        </span>
      ))}
      {more > 0 && <span className={`${CHIP} font-medium`}>+{more}</span>}
    </div>
  );
}
