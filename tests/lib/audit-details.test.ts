import { describe, expect, it } from "vitest";
import { auditEventDetails } from "@/lib/audit-details";

/** S5 — the audit details shown next to an action: a per-action whitelist, never a metadata dump. */
describe("auditEventDetails", () => {
  it("a cancelled reception: reason label, note, parcel", () => {
    expect(
      auditEventDetails({
        action: "order.return_reception_cancelled",
        metadata: { reason: "COLIS_VIDE", reasonLabel: "Colis vide", note: "  Carton vide  " },
        previousValue: { trackingNumber: "OZX123", warehouseId: "wh-1" },
      })
    ).toEqual(["Motif : Colis vide", "Note : Carton vide", "Colis : OZX123"]);
  });

  it("missing or malformed fields are skipped, never printed as « undefined »", () => {
    expect(auditEventDetails({ action: "order.return_reception_cancelled", metadata: { reason: "DEJA_RETOURNE", note: null } })).toEqual([
      "Motif : DEJA_RETOURNE",
    ]);
    expect(auditEventDetails({ action: "order.return_reception_cancelled", metadata: ["x"], previousValue: "y" })).toEqual([]);
  });

  it("an order status moved by its shipment says so", () => {
    expect(auditEventDetails({ action: "order.status_changed", metadata: { via: "shipment", shipmentStatus: "LIVRE" } })).toEqual([
      "Automatique : expédition passée « Livré »",
    ]);
    expect(auditEventDetails({ action: "order.status_changed", metadata: { note: "à la main" } })).toEqual([]);
  });

  it("anything else shows nothing — e.g. a failed login's email never leaks into the journal", () => {
    expect(auditEventDetails({ action: "user.login.failure", metadata: { email: "victim@example.com" } })).toEqual([]);
  });
});
