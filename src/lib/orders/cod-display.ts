import type { OrderStatus, PaymentMethod } from "@prisma/client";
import { NON_REVENUE_ORDER_STATUSES } from "@/lib/metrics/formulas";

/**
 * « À encaisser à la livraison (COD) » on the order page — DISPLAY ONLY.
 *
 * The rule is the one finance already applies (src/lib/queries/reports/cashflow.ts,
 * glossary `cashAwaiting`): an order in NON_REVENUE_ORDER_STATUSES (annulée,
 * en échec, retournée, remboursée) « will never pay », so nothing is left to
 * collect on it. Showing its total as « à encaisser » contradicted the reports.
 * Payment records, refunds and finance computations are untouched.
 */
export type CodDisplay =
  | { kind: "none" } // prepaid: no COD line
  | { kind: "amount"; amount: number }
  | { kind: "nothing"; label: string };

const NOTHING_LABEL: Partial<Record<OrderStatus, string>> = {
  RETOUR: "Non encaissé — commande retournée",
  ANNULEE: "Rien à encaisser — commande annulée",
  ECHEC: "Non encaissé — livraison en échec",
  REMBOURSEE: "Rien à encaisser — commande remboursée",
};

export function codDisplay(params: {
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  total: number;
  completedRefunds: number;
}): CodDisplay {
  if (params.paymentMethod !== "PAIEMENT_LIVRAISON") return { kind: "none" };
  if (NON_REVENUE_ORDER_STATUSES.includes(params.status)) {
    return { kind: "nothing", label: NOTHING_LABEL[params.status] ?? "Rien à encaisser" };
  }
  return { kind: "amount", amount: params.total - params.completedRefunds };
}
