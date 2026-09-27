import { describe, expect, it } from "vitest";
import { canTransitionOrderStatus, ORDER_STATUS_TRANSITIONS, type OrderStatusValue } from "@/lib/validation/order";

/**
 * Final Audit — the order-detail page's "Annuler la commande" button used to
 * gate on a hardcoded exclusion list (`!["ANNULEE", "REMBOURSEE"].includes(status)`)
 * instead of this canonical state-machine table, so it stayed clickable
 * (and always failed server-side) on EXPEDIEE / LIVREE / RETOUR orders.
 * The fix reuses `canTransitionOrderStatus(status, "ANNULEE")` directly —
 * this is the one place that truth now comes from, so it gets its own
 * direct, DB-free coverage rather than relying only on the UI's own
 * indirect exercise of it.
 */
describe("canTransitionOrderStatus — the exact predicate the order-detail cancel button now uses", () => {
  const ALL_STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatusValue[];

  it("allows cancelling from every status that can genuinely still be cancelled", () => {
    expect(canTransitionOrderStatus("NOUVELLE", "ANNULEE")).toBe(true);
    expect(canTransitionOrderStatus("CONFIRMEE", "ANNULEE")).toBe(true);
    expect(canTransitionOrderStatus("EN_PREPARATION", "ANNULEE")).toBe(true);
    expect(canTransitionOrderStatus("ECHEC", "ANNULEE")).toBe(true);
  });

  it("refuses cancelling once the order has physically shipped or is otherwise terminal — the exact regression this batch fixes", () => {
    expect(canTransitionOrderStatus("EXPEDIEE", "ANNULEE")).toBe(false);
    expect(canTransitionOrderStatus("LIVREE", "ANNULEE")).toBe(false);
    expect(canTransitionOrderStatus("RETOUR", "ANNULEE")).toBe(false);
    expect(canTransitionOrderStatus("REMBOURSEE", "ANNULEE")).toBe(false);
    expect(canTransitionOrderStatus("ANNULEE", "ANNULEE")).toBe(false); // same-state guard
  });

  it("every status resolves to a defined (never undefined) transition list — the button-gating code can safely index any live order status", () => {
    for (const status of ALL_STATUSES) {
      expect(ORDER_STATUS_TRANSITIONS[status]).toBeDefined();
      expect(Array.isArray(ORDER_STATUS_TRANSITIONS[status])).toBe(true);
    }
  });
});
