import { describe, expect, it } from "vitest";
import {
  mapSenditStatus,
  senditStatusLabel,
  SENDIT_RETURN_STATUSES,
  SENDIT_STATUS_LABELS,
  SENDIT_STATUS_MAPPING_STATUS,
  SENDIT_STATUSES,
} from "@/lib/integrations/delivery/providers/sendit/status";

const EXPECTED: Record<string, string> = {
  PENDING: "EN_ATTENTE",
  TO_PREPARE: "EN_ATTENTE",
  TO_PICKUP: "EN_ATTENTE",
  NEW_DESTINATION: "EN_ATTENTE",
  PICKEDUP: "EN_TRANSIT",
  WAREHOUSE: "EN_TRANSIT",
  TRANSIT: "EN_TRANSIT",
  DISTRIBUTED: "EN_TRANSIT",
  DELIVERING: "EN_TRANSIT",
  SCHEDULED: "EN_TRANSIT",
  POSTPONED: "EN_TRANSIT",
  UNREACHABLE: "EN_TRANSIT",
  DELIVERED: "LIVRE",
  CANCELED: "ECHEC",
  REJECTED: "ECHEC",
};

describe("Sendit provisional status mapping", () => {
  it("is flagged provisional", () => {
    expect(SENDIT_STATUS_MAPPING_STATUS).toBe("PROVISIONAL_PENDING_OWNER_REVIEW");
  });

  it("covers exactly the 15 documented statuses", () => {
    expect(SENDIT_STATUSES.sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(SENDIT_STATUSES).toHaveLength(15);
  });

  it.each(Object.entries(EXPECTED))("%s → %s", (raw, local) => {
    expect(mapSenditStatus(raw)).toBe(local);
    expect(mapSenditStatus(` ${raw.toLowerCase()} `)).toBe(local);
  });

  it("RETURN_STOCK / RETURN_SELLER take precedence over status", () => {
    expect(mapSenditStatus("CANCELED", "RETURN_STOCK")).toBe("RETOURNE");
    expect(mapSenditStatus("REJECTED", "RETURN_SELLER")).toBe("RETOURNE");
    expect(mapSenditStatus(null, "RETURN_SELLER")).toBe("RETOURNE");
    expect(mapSenditStatus("DELIVERED", "return_stock")).toBe("RETOURNE");
  });

  it("other return states do not override status", () => {
    for (const r of SENDIT_RETURN_STATUSES.filter((s) => s !== "RETURN_STOCK" && s !== "RETURN_SELLER")) {
      expect(mapSenditStatus("CANCELED", r)).toBe("ECHEC");
      expect(mapSenditStatus(null, r)).toBeNull();
    }
  });

  it("unknown → null", () => {
    expect(mapSenditStatus("LOST_IN_SPACE")).toBeNull();
    expect(mapSenditStatus("")).toBeNull();
    expect(mapSenditStatus(null)).toBeNull();
    expect(mapSenditStatus(undefined, "WHATEVER")).toBeNull();
  });

  it("exposes the documented French labels", () => {
    expect(SENDIT_STATUS_LABELS.TO_PICKUP).toBe("Ramassage en cours");
    expect(senditStatusLabel("delivered")).toBe("Livré");
    expect(senditStatusLabel("NOPE")).toBeNull();
  });
});
