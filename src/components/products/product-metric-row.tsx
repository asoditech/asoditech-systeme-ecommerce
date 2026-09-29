/**
 * A compact product/variation identity fragment — Phase 2 UI refinement.
 * Name + SKU/variant on two lines, an optional thumbnail, an optional
 * trailing meta (stock count, quantity, …). Meant to replace the same
 * hand-rolled "font-medium name / font-mono sku" pair repeated across
 * reception/transfer line tables and supplier purchase history — never a
 * full card, so it drops straight into an existing `<TableCell>` or a
 * plain row.
 */
export function ProductMetricRow({
  imageUrl,
  name,
  sku,
  variantLabel,
  meta,
}: {
  imageUrl?: string | null;
  name: string;
  sku: string;
  variantLabel?: string | null;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant/WooCommerce/Shopify host, can't be allow-listed for next/image
        <img src={imageUrl} alt="" className="size-8 shrink-0 rounded-md border object-cover" />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {sku}
          {variantLabel ? ` — ${variantLabel}` : ""}
        </p>
      </div>
      {meta && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}
