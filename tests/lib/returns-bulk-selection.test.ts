import { describe, expect, it } from "vitest";
import { isBulkReceivable, returnParcelNextStep, summarizeBulkReceive } from "@/lib/returns/bulk-selection";

/** Returns workspace — selection rules and the per-parcel batch summary (pure). */
describe("returns bulk selection", () => {
  it("only a returned parcel still to receive is selectable", () => {
    expect(isBulkReceivable({ eligible: true, state: "A_RECEPTIONNER" })).toBe(true);
    expect(isBulkReceivable({ eligible: false, state: "A_RECEPTIONNER" })).toBe(false);
    expect(isBulkReceivable({ eligible: true, state: "A_INSPECTER" })).toBe(false);
    expect(isBulkReceivable({ eligible: true, state: "INSPECTE" })).toBe(false);
    expect(isBulkReceivable({ eligible: true, state: "DEJA_RETOURNE" })).toBe(false);
  });

  it("next step per stage", () => {
    expect(returnParcelNextStep({ eligible: true, state: "A_RECEPTIONNER", remainingUnits: 2 })).toBe("Réceptionner le colis");
    expect(returnParcelNextStep({ eligible: true, state: "A_INSPECTER", remainingUnits: 2 })).toBe("Inspecter les articles");
    expect(returnParcelNextStep({ eligible: true, state: "INSPECTE", remainingUnits: 0 })).toBe("Terminé");
    expect(returnParcelNextStep({ eligible: true, state: "INSPECTE", remainingUnits: 1 })).toMatch(/1 unité/);
    expect(returnParcelNextStep({ eligible: false, state: "A_RECEPTIONNER", remainingUnits: 1 })).toMatch(/Non éligible/);
  });

  it("a mixed batch is never reported as all OK", () => {
    const s = summarizeBulkReceive([
      { shipmentId: "a", result: { ok: true, status: "received", receptionId: "r1" } },
      { shipmentId: "b", result: { ok: true, status: "already_pending", receptionId: "r2", receivedAt: new Date() } },
      { shipmentId: "c", result: { ok: false, code: "not_eligible", error: "Non éligible." } },
    ]);
    expect(s).toMatchObject({ received: 1, alreadyPending: 1, allOk: false });
    expect(s.failed).toEqual([{ shipmentId: "c", error: "Non éligible." }]);
    expect(s.message).toBe("1 réceptionné(s), 1 déjà réceptionné(s), 1 en erreur.");
  });

  it("all received → allOk; empty → not OK", () => {
    expect(summarizeBulkReceive([{ shipmentId: "a", result: { ok: true, status: "received", receptionId: "r" } }]).allOk).toBe(true);
    expect(summarizeBulkReceive([]).allOk).toBe(false);
  });
});
