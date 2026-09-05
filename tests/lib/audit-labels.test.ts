import { describe, expect, it } from "vitest";
import {
  humanizeAuditAction,
  humanizeAuditEntity,
  auditEntityHref,
  auditActionCategory,
  actionsForCategory,
  AUDIT_CATEGORY_LABELS,
} from "@/lib/audit-labels";

describe("humanizeAuditAction", () => {
  it("returns the mapped French phrase for a known action code", () => {
    expect(humanizeAuditAction("integration.webhook_rejected")).toBe("Webhook rejeté (signature invalide)");
    expect(humanizeAuditAction("order.created")).toBe("Commande créée");
  });

  it("never shows the raw dotted/underscored code for an unmapped action — falls back to a prettified version", () => {
    const result = humanizeAuditAction("product.some_future_event");
    expect(result).not.toContain(".");
    expect(result).not.toContain("_");
    expect(result).toBe("Product Some Future Event");
  });
});

describe("humanizeAuditEntity", () => {
  it("translates known entity types", () => {
    expect(humanizeAuditEntity("Order")).toBe("Commande");
    expect(humanizeAuditEntity("Integration")).toBe("Intégration");
  });

  it("falls back to the raw type for an unmapped one", () => {
    expect(humanizeAuditEntity("SomeFutureModel")).toBe("SomeFutureModel");
  });
});

describe("auditEntityHref", () => {
  it("links the entity types with a real detail page reachable by id alone", () => {
    expect(auditEntityHref("Order", "abc123")).toBe("/commandes/abc123");
    expect(auditEntityHref("Customer", "abc123")).toBe("/clients/abc123");
    expect(auditEntityHref("Integration", "abc123")).toBe("/integrations");
  });

  it("returns null for a type with no dedicated route", () => {
    expect(auditEntityHref("SyncRun", "abc123")).toBeNull();
    expect(auditEntityHref("InventoryItem", "abc123")).toBeNull();
  });
});

describe("category mapping", () => {
  it("every category filter option resolves to at least one action code", () => {
    for (const category of Object.keys(AUDIT_CATEGORY_LABELS) as (keyof typeof AUDIT_CATEGORY_LABELS)[]) {
      expect(actionsForCategory(category).length).toBeGreaterThan(0);
    }
  });

  it("categorizes a representative action from each bucket correctly", () => {
    expect(auditActionCategory("order.created")).toBe("commandes");
    expect(auditActionCategory("customer.created")).toBe("clients");
    expect(auditActionCategory("inventory.adjusted")).toBe("produits_stock");
    expect(auditActionCategory("shipment.created")).toBe("livraison");
    expect(auditActionCategory("expense.created")).toBe("finance");
    expect(auditActionCategory("integration.webhook_received")).toBe("integrations");
    expect(auditActionCategory("user.login.success")).toBe("utilisateurs");
  });

  it("returns null for an unmapped action, and every category's action set actually maps back to it", () => {
    expect(auditActionCategory("some.unmapped.action")).toBeNull();
    for (const category of Object.keys(AUDIT_CATEGORY_LABELS) as (keyof typeof AUDIT_CATEGORY_LABELS)[]) {
      for (const action of actionsForCategory(category)) {
        expect(auditActionCategory(action)).toBe(category);
      }
    }
  });
});
