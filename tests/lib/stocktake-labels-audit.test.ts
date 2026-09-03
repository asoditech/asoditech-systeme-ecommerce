import { describe, expect, it } from "vitest";
import {
  STOCKTAKE_STATUS_LABELS,
  INVENTORY_MOVEMENT_TYPE_LABELS,
} from "@/lib/status-labels";
import type { AuditAction } from "@/lib/audit";

describe("stocktake status labels (Phase 32c)", () => {
  it("labels every StocktakeStatus value in French with a badge variant", () => {
    expect(STOCKTAKE_STATUS_LABELS.EN_COURS).toEqual({ label: "En cours", variant: "secondary" });
    expect(STOCKTAKE_STATUS_LABELS.CLOTURE).toEqual({ label: "Clôturé", variant: "default" });
    expect(STOCKTAKE_STATUS_LABELS.ANNULE).toEqual({ label: "Annulé", variant: "outline" });
    expect(Object.keys(STOCKTAKE_STATUS_LABELS).sort()).toEqual(["ANNULE", "CLOTURE", "EN_COURS"]);
  });
});

describe("INVENTAIRE movement label (Phase 32c)", () => {
  it("labels the new movement type", () => {
    expect(INVENTORY_MOVEMENT_TYPE_LABELS.INVENTAIRE).toBe("Inventaire");
  });
});

describe("stocktake audit actions (Phase 32c)", () => {
  it("are valid AuditAction values", () => {
    // Compile-time: these must be assignable to the AuditAction union.
    const actions: AuditAction[] = ["stocktake.created", "stocktake.closed", "stocktake.cancelled"];
    expect(actions).toEqual(["stocktake.created", "stocktake.closed", "stocktake.cancelled"]);
    // Namespaced "entity.verb" convention, like every other AuditAction.
    for (const a of actions) expect(a).toMatch(/^stocktake\.[a-z]+$/);
  });
});
