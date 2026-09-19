import { describe, expect, it } from "vitest";
import { computeEffectiveAccess } from "@/lib/auth/effective-access";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import {
  BUSINESS_MODES,
  DEFAULT_BUSINESS_MODE,
  MODE_CAPABILITIES,
  PERMISSION_CAPABILITY,
  TENANT_CAPABILITIES,
  capabilitiesForMode,
  isBusinessMode,
  permissionAvailable,
} from "@/lib/tenant/business-mode";
import { categoriesFor, isCategoryAvailable } from "@/lib/docs/categories";
import { articlesFor, ALL_ARTICLES } from "@/lib/docs/registry";

/**
 * Tenant business mode — pure rules (docs/adr/0041). ONLINE_ONLY must be the
 * pre-existing product; ONLINE_AND_OFFLINE unlocks the Offline capabilities.
 */

const ROLES = ["OWNER", "ADMIN", "MANAGER", "CONFIRMATION", "WAREHOUSE", "DELIVERY", "SUPPORT", "ACCOUNTANT"] as const;

/** Every permission introduced by the Online+Offline work — the ONLY ones a mode may gate. */
const OFFLINE_ERA_PERMISSIONS: Permission[] = [
  "suppliers.view", "suppliers.manage", "purchases.view", "purchases.create", "purchases.pay",
  "sales.view", "sales.create", "sales.return", "sales.override_price", "channels.manage", "traceability.view",
];

describe("the mode → capability matrix", () => {
  it("ONLINE_ONLY is the default and unlocks NOTHING", () => {
    expect(DEFAULT_BUSINESS_MODE).toBe("ONLINE_ONLY");
    expect(MODE_CAPABILITIES.ONLINE_ONLY).toEqual([]);
    expect(capabilitiesForMode("ONLINE_ONLY").size).toBe(0);
  });

  it("ONLINE_AND_OFFLINE unlocks every capability", () => {
    expect([...capabilitiesForMode("ONLINE_AND_OFFLINE")].sort()).toEqual([...TENANT_CAPABILITIES].sort());
  });

  it("recognises exactly the two modes", () => {
    expect([...BUSINESS_MODES]).toEqual(["ONLINE_ONLY", "ONLINE_AND_OFFLINE"]);
    expect(isBusinessMode("ONLINE_ONLY")).toBe(true);
    expect(isBusinessMode("OFFLINE_ONLY")).toBe(false);
    expect(isBusinessMode(undefined)).toBe(false);
  });

  it("gates ONLY the Offline-era permissions — no pre-existing permission is ever gated by a mode", () => {
    expect(Object.keys(PERMISSION_CAPABILITY).sort()).toEqual([...OFFLINE_ERA_PERMISSIONS].sort());
    const legacy = PERMISSIONS.filter((p) => !OFFLINE_ERA_PERMISSIONS.includes(p));
    for (const p of legacy) expect(permissionAvailable(p, new Set())).toBe(true);
  });

  it("every Offline-era permission is unavailable without its capability and available with it", () => {
    for (const p of OFFLINE_ERA_PERMISSIONS) {
      expect(permissionAvailable(p, capabilitiesForMode("ONLINE_ONLY"))).toBe(false);
      expect(permissionAvailable(p, capabilitiesForMode("ONLINE_AND_OFFLINE"))).toBe(true);
    }
  });
});

describe("ONLINE_ONLY effective access == the previous system", () => {
  const eff = (role: (typeof ROLES)[number], extra: Partial<Parameters<typeof computeEffectiveAccess>[0]> = {}) =>
    computeEffectiveAccess({ role, overrides: [], assignedChannels: [], businessMode: "ONLINE_ONLY", ...extra });

  it("every role holds exactly its baseline minus the Offline-era permissions — for OWNER/ADMIN too", () => {
    for (const role of ROLES) {
      const expected = (role === "OWNER" || role === "ADMIN" ? [...PERMISSIONS] : [...ROLE_PERMISSIONS[role]]).filter(
        (p) => !OFFLINE_ERA_PERMISSIONS.includes(p)
      );
      expect([...eff(role).permissions].sort()).toEqual(expected.sort());
    }
  });

  it("channel scope is IGNORED: a user with NO channel rows keeps every Online permission (a missing row can never lock anyone out)", () => {
    const e = eff("MANAGER", { assignedChannels: [] });
    expect(e.permissions.has("orders.view")).toBe(true);
    expect(e.permissions.has("orders.confirm")).toBe(true);
    expect(e.permissions.has("delivery.manage")).toBe(true);
    expect(e.channels).toMatchObject({ online: true, offline: false });
  });

  it("stray channel rows change nothing (an OFFLINE row cannot switch Online off, or Offline on)", () => {
    const e = eff("MANAGER", { assignedChannels: [{ id: "store", kind: "OFFLINE", isActive: true }] });
    expect(e.channels).toMatchObject({ online: true, offline: false });
    expect(e.permissions.has("orders.view")).toBe(true);
    expect(e.permissions.has("sales.create")).toBe(false);
  });

  it("Offline is off for EVERYONE, including OWNER/ADMIN", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(eff(role).channels).toMatchObject({ global: true, online: true, offline: false });
      for (const p of OFFLINE_ERA_PERMISSIONS) expect(eff(role).permissions.has(p)).toBe(false);
    }
  });

  it("a GRANT of an Offline permission is inert; a DENY of an Online one still works", () => {
    const e = eff("CONFIRMATION", {
      overrides: [
        { permission: "sales.create", effect: "GRANT" },
        { permission: "suppliers.manage", effect: "GRANT" },
        { permission: "orders.confirm", effect: "DENY" },
      ],
    });
    expect(e.permissions.has("sales.create")).toBe(false);
    expect(e.permissions.has("suppliers.manage")).toBe(false);
    expect(e.permissions.has("orders.confirm")).toBe(false);
    expect(e.permissions.has("orders.view")).toBe(true);
  });

  it("capabilities and mode are exposed on the result", () => {
    expect(eff("OWNER").businessMode).toBe("ONLINE_ONLY");
    expect(eff("OWNER").capabilities.size).toBe(0);
  });
});

describe("ONLINE_AND_OFFLINE effective access", () => {
  it("OWNER/ADMIN hold every permission and both activities; other roles keep the A–G channel-scope rules", () => {
    const owner = computeEffectiveAccess({ role: "OWNER", overrides: [], assignedChannels: [], businessMode: "ONLINE_AND_OFFLINE" });
    expect(owner.permissions.size).toBe(PERMISSIONS.length);
    expect(owner.channels).toMatchObject({ global: true, online: true, offline: true });

    const mgr = computeEffectiveAccess({ role: "MANAGER", overrides: [], assignedChannels: [], businessMode: "ONLINE_AND_OFFLINE" });
    expect(mgr.permissions.has("orders.view")).toBe(false); // zero channels = default-deny, as in ADR 0039
    expect(mgr.permissions.has("products.view")).toBe(true);
  });

  it("the only difference between the two modes for OWNER is exactly the Offline-era permissions", () => {
    const on = computeEffectiveAccess({ role: "OWNER", overrides: [], assignedChannels: [], businessMode: "ONLINE_ONLY" }).permissions;
    const both = computeEffectiveAccess({ role: "OWNER", overrides: [], assignedChannels: [], businessMode: "ONLINE_AND_OFFLINE" }).permissions;
    expect([...both].filter((p) => !on.has(p)).sort()).toEqual([...OFFLINE_ERA_PERMISSIONS].sort());
  });
});

describe("documentation is capability-aware", () => {
  it("the Magasin category and its articles are hidden without the capability, visible with it", () => {
    const none = capabilitiesForMode("ONLINE_ONLY");
    const all = capabilitiesForMode("ONLINE_AND_OFFLINE");
    expect(categoriesFor(none).some((c) => c.id === "magasin")).toBe(false);
    expect(categoriesFor(all).some((c) => c.id === "magasin")).toBe(true);
    expect(isCategoryAvailable("magasin", none)).toBe(false);
    expect(isCategoryAvailable("stock", none)).toBe(true);
    expect(articlesFor(none).some((a) => a.category === "magasin")).toBe(false);
    expect(articlesFor(all).length).toBe(ALL_ARTICLES.length);
    // Every OTHER article is unaffected.
    expect(articlesFor(none).length).toBe(ALL_ARTICLES.filter((a) => a.category !== "magasin").length);
  });
});
