import { describe, expect, it } from "vitest";
import { codDisplay } from "@/lib/orders/cod-display";
import { NON_REVENUE_ORDER_STATUSES } from "@/lib/metrics/formulas";

/** « À encaisser (COD) » on the order page follows the cashflow rule: non-revenue orders never pay. */
describe("codDisplay", () => {
  const base = { paymentMethod: "PAIEMENT_LIVRAISON" as const, total: 300, completedRefunds: 0 };

  it("a returned COD order shows « Non encaissé — commande retournée », not its total", () => {
    expect(codDisplay({ ...base, status: "RETOUR" })).toEqual({ kind: "nothing", label: "Non encaissé — commande retournée" });
  });

  it("every non-revenue status has nothing to collect", () => {
    for (const status of NON_REVENUE_ORDER_STATUSES) {
      expect(codDisplay({ ...base, status }).kind).toBe("nothing");
    }
  });

  it("an in-progress COD order keeps total minus completed refunds", () => {
    expect(codDisplay({ ...base, status: "EXPEDIEE", completedRefunds: 50 })).toEqual({ kind: "amount", amount: 250 });
  });

  it("a prepaid order has no COD line, whatever its status", () => {
    expect(codDisplay({ ...base, paymentMethod: "CARTE_BANCAIRE", status: "RETOUR" })).toEqual({ kind: "none" });
  });
});
