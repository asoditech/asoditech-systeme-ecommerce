import { Prisma } from "@prisma/client";
import type { CostingMethod } from "@prisma/client";

/**
 * Product costing (Phase 3 — Product Costing & Profitability input).
 *
 * Pure, unit-testable math for one thing only: what a product/variation's
 * CURRENT STANDARD cost (`Product.cost` / `ProductVariation.cost`) should
 * become after ONE validated reception line. This is deliberately a
 * DIFFERENT concept from the HISTORICAL REALIZED cost already frozen on
 * `OrderItem.costSnapshot` / `SaleLine.costSnapshot` at the moment of a
 * sale (docs/adr/0002, 0007) — this module never reads or writes a
 * snapshot, never touches an existing sale/order, and is called from
 * exactly one place: `validateReceptionInTx` in src/lib/receptions.ts.
 *
 * No I/O here (no Prisma client, no `server-only`) — the caller resolves
 * every input (the tenant's chosen method, the on-hand quantity BEFORE
 * this line, the current cost, the received quantity/cost) and this module
 * only computes. Money math uses `Prisma.Decimal` throughout, matching the
 * project's existing convention (see `d2()` in src/lib/receptions.ts) —
 * never a JS float — and is never rounded here: the destination columns
 * (`Decimal(12,2)`) apply the database's own scale on write.
 */

export interface ComputeUpdatedCostInput {
  method: CostingMethod;
  /**
   * On-hand quantity for this exact product/variation at the reception's
   * warehouse, BEFORE this reception line was applied. Only meaningful for
   * WEIGHTED_AVERAGE.
   */
  existingOnHand: number;
  /**
   * The product/variation's current standard cost before this reception —
   * `null` when it was never set. Never fabricated: a `null` here must stay
   * `null` unless a method explicitly resolves a value from it.
   */
  existingCost: Prisma.Decimal | null;
  /** Quantity received on this line. Must be > 0 (a reception line's own DB CHECK already guarantees this; enforced here too, defensively.) */
  receivedQty: number;
  /** Unit cost recorded on this reception line. Must be >= 0 (also DB-enforced on `ReceptionLine.unitCost`; enforced here too, defensively.) */
  receivedUnitCost: Prisma.Decimal;
}

/**
 * Returns the new CURRENT STANDARD cost for one product/variation after one
 * validated reception line — or `null` when there simply is no cost to
 * report (MANUAL with no existing cost yet). The caller (`validateReceptionInTx`)
 * additionally short-circuits and issues NO database write at all under
 * MANUAL — this function still answers faithfully for MANUAL (existing
 * cost, unchanged) so it stays a complete, independently testable
 * decision table for all three methods rather than a partial one.
 *
 *  - MANUAL: the existing cost, unchanged — this method never computes
 *    anything; a caller must not persist this as if it were a real update.
 *  - LAST_COST: the received unit cost, unconditionally — the simplest,
 *    most recent-purchase-reflects-reality method.
 *  - WEIGHTED_AVERAGE: a quantity-weighted blend of what's already on hand
 *    and what was just received —
 *      (existingOnHand × existingCost + receivedQty × receivedUnitCost)
 *      ÷ (existingOnHand + receivedQty)
 *    with two explicit, deliberate exceptions that never fabricate a
 *    number from missing data:
 *      1. `existingOnHand <= 0` — there is nothing to weight against; the
 *         resulting cost becomes the received unit cost.
 *      2. `existingOnHand > 0` but `existingCost === null` — there IS
 *         existing stock, but no cost was ever recorded for it. Blending
 *         an unknown cost as if it were zero would silently understate the
 *         result, and inventing a historical cost is exactly what this
 *         phase must never do. The safe behavior is the same as (1): the
 *         received unit cost becomes the new current cost.
 */
export function computeUpdatedCost(input: ComputeUpdatedCostInput): Prisma.Decimal | null {
  if (input.receivedQty <= 0) {
    throw new Error("computeUpdatedCost: receivedQty must be > 0.");
  }
  if (input.receivedUnitCost.lessThan(0)) {
    throw new Error("computeUpdatedCost: receivedUnitCost must be >= 0.");
  }

  switch (input.method) {
    case "MANUAL":
      return input.existingCost;

    case "LAST_COST":
      return input.receivedUnitCost;

    case "WEIGHTED_AVERAGE": {
      if (input.existingOnHand <= 0 || input.existingCost === null) {
        return input.receivedUnitCost;
      }
      const existingValue = input.existingCost.times(input.existingOnHand);
      const receivedValue = input.receivedUnitCost.times(input.receivedQty);
      const totalQty = input.existingOnHand + input.receivedQty;
      return existingValue.plus(receivedValue).dividedBy(totalQty);
    }

    default: {
      // Exhaustiveness guard — a new CostingMethod enum member without a
      // matching case here is a build-time error, never a silent no-op.
      const _exhaustive: never = input.method;
      throw new Error(`computeUpdatedCost: unhandled costing method ${_exhaustive as string}`);
    }
  }
}
