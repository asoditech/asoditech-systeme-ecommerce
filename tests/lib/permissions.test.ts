import { describe, expect, it } from "vitest";
import { hasPermission, ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/auth/permissions";

describe("RBAC permission matrix", () => {
  it("grants OWNER and ADMIN every defined permission", () => {
    for (const perm of PERMISSIONS) {
      expect(hasPermission("OWNER", perm)).toBe(true);
      expect(hasPermission("ADMIN", perm)).toBe(true);
    }
  });

  it("never grants users.manage or settings.manage to non-admin roles", () => {
    const restricted: Array<keyof typeof ROLE_PERMISSIONS> = [
      "SALES",
      "WAREHOUSE",
      "DELIVERY",
      "SUPPORT",
      "ACCOUNTANT",
      "MANAGER",
    ];
    for (const role of restricted) {
      expect(hasPermission(role, "users.manage")).toBe(false);
      expect(hasPermission(role, "settings.manage")).toBe(false);
    }
  });

  it("only grants finance.manage to roles that need it", () => {
    expect(hasPermission("ACCOUNTANT", "finance.manage")).toBe(true);
    expect(hasPermission("OWNER", "finance.manage")).toBe(true);
    expect(hasPermission("SALES", "finance.manage")).toBe(false);
    expect(hasPermission("WAREHOUSE", "finance.manage")).toBe(false);
    expect(hasPermission("DELIVERY", "finance.manage")).toBe(false);
  });

  it("only grants inventory.adjust to roles responsible for stock", () => {
    expect(hasPermission("WAREHOUSE", "inventory.adjust")).toBe(true);
    expect(hasPermission("MANAGER", "inventory.adjust")).toBe(true);
    expect(hasPermission("SALES", "inventory.adjust")).toBe(false);
    expect(hasPermission("SUPPORT", "inventory.adjust")).toBe(false);
  });

  it("grants every role dashboard.view", () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>) {
      expect(hasPermission(role, "dashboard.view")).toBe(true);
    }
  });

  it("does not grant orders.cancel or orders.refund to SALES", () => {
    expect(hasPermission("SALES", "orders.cancel")).toBe(false);
    expect(hasPermission("SALES", "orders.refund")).toBe(false);
  });
});
