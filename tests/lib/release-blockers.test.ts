import { describe, expect, it } from "vitest";
import { courierUpdateData } from "@/lib/integrations/delivery/tracking-service";
import { confirmationCeiling } from "@/lib/stock-validation";
import { stockRowKey } from "@/lib/inventory";
import {
  RETURN_RECEPTION_CANCEL_REASONS,
  RETURN_RECEPTION_CANCEL_REASON_LABELS,
  cancelReturnReceptionSchema,
} from "@/lib/validation/return-receiving";
import { auditActionCategory, humanizeAuditAction } from "@/lib/audit-labels";

/** Release-blocker fixes — the pure rules. No database. */

describe("M5 — courierUpdateData: name and phone describe ONE courier", () => {
  const stored = { courierName: "Youssef", courierPhone: "0655555555" };

  it("a new courier without a phone never keeps the previous courier's number", () => {
    expect(courierUpdateData({ name: "Karim", phone: null }, stored)).toEqual({ courierName: "Karim", courierPhone: null });
    expect(courierUpdateData({ name: "Karim", phone: "   " }, stored)).toEqual({ courierName: "Karim", courierPhone: null });
  });

  it("a new courier with a phone replaces both", () => {
    expect(courierUpdateData({ name: "Karim", phone: "0677777777" }, stored)).toEqual({ courierName: "Karim", courierPhone: "0677777777" });
  });

  it("the same courier (any case / spacing) without a phone keeps the stored phone", () => {
    expect(courierUpdateData({ name: "Youssef", phone: null }, stored)).toEqual({});
    expect(courierUpdateData({ name: "  youssef ", phone: null }, stored)).toEqual({});
  });

  it("the same courier with a new phone refreshes only the phone", () => {
    expect(courierUpdateData({ name: "Youssef", phone: "0611111111" }, stored)).toEqual({ courierPhone: "0611111111" });
  });

  it("no courier in the response wipes nothing", () => {
    expect(courierUpdateData(undefined, stored)).toEqual({});
    expect(courierUpdateData(null, stored)).toEqual({});
    expect(courierUpdateData({ name: null, phone: null }, stored)).toEqual({});
  });

  it("a phone without a name refreshes the phone only; a first courier is recorded", () => {
    expect(courierUpdateData({ name: null, phone: "0622222222" }, stored)).toEqual({ courierPhone: "0622222222" });
    expect(courierUpdateData({ name: "Youssef", phone: null }, { courierName: null, courierPhone: null })).toEqual({
      courierName: "Youssef",
      courierPhone: null,
    });
  });
});

describe("M3 — confirmationCeiling: an unknown row never means « no check » for a tracked line", () => {
  const tracked = { productId: "p-tracked", variationId: null, trackInventory: true };
  const trackedVariation = { productId: "p-parent", variationId: "v-1", trackInventory: true };
  const untracked = { productId: "p-free", variationId: null, trackInventory: false };
  const W1 = "wh-1";
  const W2 = "wh-2";

  it("a row the pre-read checked keeps its ceiling (0 or the accepted overcommit)", () => {
    const ceiling = confirmationCeiling(new Map([[stockRowKey(W1, tracked), 0], [stockRowKey(W1, trackedVariation), 3]]), [tracked, trackedVariation]);
    expect(ceiling(stockRowKey(W1, tracked))).toBe(0);
    expect(ceiling(stockRowKey(W1, trackedVariation))).toBe(3);
  });

  it("a tracked line hitting a row the pre-read did not see (other warehouse / new row) is held to 0", () => {
    const ceiling = confirmationCeiling(new Map([[stockRowKey(W1, tracked), 2]]), [tracked, trackedVariation]);
    expect(ceiling(stockRowKey(W2, tracked))).toBe(0);
    expect(ceiling(stockRowKey(W1, trackedVariation))).toBe(0);
  });

  it("an untracked product keeps its historical no-ceiling behaviour, wherever it lands", () => {
    const ceiling = confirmationCeiling(new Map(), [untracked, tracked]);
    expect(ceiling(stockRowKey(W1, untracked))).toBeUndefined();
    expect(ceiling(stockRowKey(W2, untracked))).toBeUndefined();
    expect(ceiling(stockRowKey(W1, tracked))).toBe(0);
  });
});

describe("M4 — cancelling a reception awaiting inspection", () => {
  it("requires a known reason; « Autre » also requires a note", () => {
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "COLIS_VIDE" }).success).toBe(true);
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "DEJA_RETOURNE", note: "Retour fait sur la commande" }).success).toBe(true);
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1" }).success).toBe(false);
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "PERDU" }).success).toBe(false);
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "AUTRE" }).success).toBe(false);
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "AUTRE", note: "  ok " }).success).toBe(false);
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "AUTRE", note: "Colis d'un autre client" }).success).toBe(true);
  });

  it("rejects forged extra keys (tenant / warehouse / order come from the server)", () => {
    expect(cancelReturnReceptionSchema.safeParse({ receptionId: "r1", reason: "COLIS_VIDE", tenantId: "x" }).success).toBe(false);
  });

  it("every reason has a French label", () => {
    for (const r of RETURN_RECEPTION_CANCEL_REASONS) expect(RETURN_RECEPTION_CANCEL_REASON_LABELS[r].length).toBeGreaterThan(3);
  });

  it("the cancellation shows in the order history in French, under Commandes", () => {
    expect(humanizeAuditAction("order.return_reception_cancelled")).toBe("Réception de colis retourné annulée");
    expect(auditActionCategory("order.return_reception_cancelled")).toBe("commandes");
  });
});
