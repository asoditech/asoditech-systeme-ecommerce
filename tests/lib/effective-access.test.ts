import { describe, expect, it } from "vitest";
import { computeEffectiveAccess, type AssignedChannelInput } from "@/lib/auth/effective-access";
import { PERMISSIONS, PERMISSION_CHANNEL_DOMAIN, ROLE_PERMISSIONS, hasPermission } from "@/lib/auth/permissions";

/**
 * effective = (role ∪ GRANTs − DENYs) filtered by channel scope
 * (docs/adr/0039). Pure rules — no database.
 */

const ONLINE: AssignedChannelInput = { id: "ch-online", kind: "ONLINE", isActive: true };
const STORE_A: AssignedChannelInput = { id: "ch-store-a", kind: "OFFLINE", isActive: true };
const STORE_B: AssignedChannelInput = { id: "ch-store-b", kind: "OFFLINE", isActive: true };

// The A–G semantics (channel scope, Offline permissions) live in a tenant that
// runs ONLINE_AND_OFFLINE; the ONLINE_ONLY rules are covered in
// tests/lib/business-mode.test.ts.
const compute = (
  role: Parameters<typeof computeEffectiveAccess>[0]["role"],
  overrides: Parameters<typeof computeEffectiveAccess>[0]["overrides"] = [],
  assignedChannels: AssignedChannelInput[] = [ONLINE]
) => computeEffectiveAccess({ role, overrides, assignedChannels, businessMode: "ONLINE_AND_OFFLINE" });

describe("role baseline", () => {
  it("with no overrides and the default ONLINE channel, effective == the role's baseline for every ONLINE/shared permission (no behaviour change)", () => {
    for (const role of ["MANAGER", "CONFIRMATION", "WAREHOUSE", "DELIVERY", "SUPPORT", "ACCOUNTANT"] as const) {
      const eff = compute(role);
      const expected = ROLE_PERMISSIONS[role].filter((p) => PERMISSION_CHANNEL_DOMAIN[p] !== "OFFLINE");
      expect([...eff.permissions].sort()).toEqual([...expected].sort());
    }
  });

  it("OWNER and ADMIN hold every permission and every channel, regardless of overrides or channel rows", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const eff = compute(role, PERMISSIONS.map((p) => ({ permission: p, effect: "DENY" as const })), []);
      expect(eff.permissions.size).toBe(PERMISSIONS.length);
      expect(eff.channels).toMatchObject({ global: true, online: true, offline: true });
    }
  });
});

describe("user GRANT / DENY", () => {
  it("a GRANT adds a permission the role lacks", () => {
    expect(hasPermission("CONFIRMATION", "inventory.view")).toBe(false);
    const eff = compute("CONFIRMATION", [{ permission: "inventory.view", effect: "GRANT" }]);
    expect(eff.permissions.has("inventory.view")).toBe(true);
  });

  it("the spec's example: a confirmation agent keeps orders.view/confirm and gains orders.cancel + suppliers-free extras only where granted", () => {
    const eff = compute("CONFIRMATION", [
      { permission: "inventory.view", effect: "GRANT" },
      { permission: "orders.return", effect: "GRANT" },
    ]);
    expect(eff.permissions.has("orders.view")).toBe(true);
    expect(eff.permissions.has("orders.confirm")).toBe(true);
    expect(eff.permissions.has("inventory.view")).toBe(true);
    expect(eff.permissions.has("orders.return")).toBe(true);
    // …and nothing she wasn't given:
    expect(eff.permissions.has("inventory.transfer")).toBe(false);
    expect(eff.permissions.has("suppliers.manage")).toBe(false);
    expect(eff.permissions.has("finance.view")).toBe(false);
  });

  it("a DENY removes a permission the role grants", () => {
    const eff = compute("MANAGER", [{ permission: "inventory.transfer", effect: "DENY" }]);
    expect(eff.permissions.has("inventory.transfer")).toBe(false);
    expect(eff.permissions.has("inventory.adjust")).toBe(true); // untouched
  });

  it("DENY overrides GRANT even when both are present for the same permission", () => {
    const eff = compute("CONFIRMATION", [
      { permission: "finance.view", effect: "GRANT" },
      { permission: "finance.view", effect: "DENY" },
    ]);
    expect(eff.permissions.has("finance.view")).toBe(false);
    // order of the rows must not matter
    const reversed = compute("CONFIRMATION", [
      { permission: "finance.view", effect: "DENY" },
      { permission: "finance.view", effect: "GRANT" },
    ]);
    expect(reversed.permissions.has("finance.view")).toBe(false);
  });

  it("an unknown / since-removed permission string is ignored, never trusted", () => {
    const eff = compute("SUPPORT", [{ permission: "orders.teleport", effect: "GRANT" }]);
    expect([...eff.permissions].some((p) => (p as string) === "orders.teleport")).toBe(false);
  });
});

describe("channel scope filters effective permissions", () => {
  it("an ONLINE-only user holds no OFFLINE-domain permission — even if the role or a GRANT gives it", () => {
    const eff = compute("MANAGER", [{ permission: "sales.override_price", effect: "GRANT" }], [ONLINE]);
    for (const p of PERMISSIONS.filter((p) => PERMISSION_CHANNEL_DOMAIN[p] === "OFFLINE")) {
      expect(eff.permissions.has(p)).toBe(false);
    }
    expect(eff.permissions.has("orders.view")).toBe(true);
    expect(eff.channels).toMatchObject({ online: true, offline: false });
  });

  it("an OFFLINE-only user holds no ONLINE-domain permission (no orders, delivery, commissions, integrations, marketing)", () => {
    const eff = compute("MANAGER", [], [STORE_A]);
    for (const p of PERMISSIONS.filter((p) => PERMISSION_CHANNEL_DOMAIN[p] === "ONLINE")) {
      expect(eff.permissions.has(p)).toBe(false);
    }
    expect(eff.permissions.has("sales.create")).toBe(true);
    expect(eff.channels).toMatchObject({ online: false, offline: true, offlineIds: [STORE_A.id] });
  });

  it("a user with both channels keeps both activities", () => {
    const eff = compute("MANAGER", [], [ONLINE, STORE_A, STORE_B]);
    expect(eff.permissions.has("orders.view")).toBe(true);
    expect(eff.permissions.has("sales.create")).toBe(true);
    expect(eff.channels.offlineIds).toEqual([STORE_A.id, STORE_B.id]);
  });

  it("zero channels = zero domain permissions (default-deny), but SHARED permissions remain", () => {
    const eff = compute("MANAGER", [], []);
    expect(eff.channels).toMatchObject({ online: false, offline: false });
    expect(eff.permissions.has("orders.view")).toBe(false);
    expect(eff.permissions.has("sales.view")).toBe(false);
    expect(eff.permissions.has("products.view")).toBe(true);
    expect(eff.permissions.has("inventory.view")).toBe(true);
  });

  it("an INACTIVE channel confers nothing", () => {
    const eff = compute("MANAGER", [], [{ ...STORE_A, isActive: false }]);
    expect(eff.channels.offline).toBe(false);
    expect(eff.permissions.has("sales.create")).toBe(false);
  });

  it("a DENY still wins inside an allowed channel", () => {
    const eff = compute("MANAGER", [{ permission: "sales.override_price", effect: "DENY" }], [STORE_A]);
    expect(eff.permissions.has("sales.create")).toBe(true);
    expect(eff.permissions.has("sales.override_price")).toBe(false);
  });
});
