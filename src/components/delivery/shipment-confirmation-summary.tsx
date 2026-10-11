import { formatCurrency } from "@/lib/format";

export type ShipmentConfirmationRow =
  | { label: string; value: string }
  /** `amount: null` = prepaid order: nothing for the courier to collect. */
  | { label: string; money: { amount: number | null; currency: string } };

/** The facts shown in a shipment-creation confirmation (single or bulk). */
export function ShipmentConfirmationSummary({ rows }: { rows: ShipmentConfirmationRow[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words font-medium tabular-nums">
            {"money" in row
              ? row.money.amount === null
                ? "Aucun (commande prépayée)"
                : formatCurrency(row.money.amount, row.money.currency)
              : row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
