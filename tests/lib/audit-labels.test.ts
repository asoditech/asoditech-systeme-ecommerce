import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    expect(humanizeAuditAction("customer.blacklisted")).toBe("Client marqué indésirable");
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

describe("labels added for previously unmapped actions", () => {
  it("shows a physical return as « Retour physique enregistré », under Commandes", () => {
    expect(humanizeAuditAction("order.return_confirmed")).toBe("Retour physique enregistré");
    expect(auditActionCategory("order.return_confirmed")).toBe("commandes");
    expect(actionsForCategory("commandes")).toContain("order.return_confirmed");
  });

  it("maps each newly labelled action to the category of its family", () => {
    const expected: Record<string, [string, string]> = {
      "category.updated": ["Catégorie modifiée", "produits_stock"],
      "customer.address.updated": ["Adresse client modifiée", "clients"],
      "marketing_campaign.updated": ["Campagne marketing modifiée", "marketing"],
      "shipment.deleted": ["Tentative d'expédition échouée supprimée", "livraison"],
      "shipping_provider.updated": ["Prestataire de livraison modifié", "livraison"],
      "user.deleted": ["Utilisateur supprimé", "utilisateurs"],
      "invitation.created": ["Invitation créée", "utilisateurs"],
      "invitation.revoked": ["Invitation révoquée", "utilisateurs"],
      "invitation.accepted": ["Invitation acceptée", "utilisateurs"],
      "invitation.expired_or_invalid_use_attempt": ["Utilisation d'invitation refusée", "utilisateurs"],
      "password_reset.requested": ["Réinitialisation du mot de passe demandée", "utilisateurs"],
      "password_reset.completed": ["Mot de passe réinitialisé", "utilisateurs"],
      "password_reset.invalid_use_attempt": ["Lien de réinitialisation invalide utilisé", "utilisateurs"],
    };
    for (const [action, [label, category]] of Object.entries(expected)) {
      expect(humanizeAuditAction(action), action).toBe(label);
      expect(auditActionCategory(action), action).toBe(category);
    }
  });
});

/**
 * Systematic coverage: every code in the `AuditAction` union
 * (src/lib/audit.ts — a type, so read from source) has a French label and a
 * category, except the deliberate exceptions below. Those keep the
 * prettified fallback until their category is decided.
 */
const UNLABELLED_BY_DESIGN: Record<string, string> = {
  // Platform-administration events (src/actions/tenants.ts) — which journal
  // category they belong to is a product decision, not yet made.
  "tenant.created": "platform action — category undecided",
  "tenant.activated": "platform action — category undecided",
  "tenant.suspended": "platform action — category undecided",
  "tenant.deleted": "platform action — category undecided",
  "tenant.baseline_provisioned": "platform action — category undecided",
  "tenant.baseline_provisioning_failed": "platform action — category undecided",
  // Declared but never written by any code path; livraison vs integrations is ambiguous.
  "shipment.webhook_received": "never emitted — category ambiguous",
  "shipment.webhook_rejected": "never emitted — category ambiguous",
};

function declaredAuditActions(): string[] {
  const source = readFileSync(join(process.cwd(), "src/lib/audit.ts"), "utf8");
  const union = source.match(/export type AuditAction\s*=([\s\S]*?);/);
  if (!union) throw new Error("AuditAction union not found in src/lib/audit.ts");
  return [...union[1].matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("audit-label coverage", () => {
  const declared = declaredAuditActions();

  it("reads the AuditAction union from source", () => {
    expect(declared.length).toBeGreaterThan(100);
    expect(declared).toContain("order.return_confirmed");
  });

  it("every declared action has a French label and a category, except the documented exceptions", () => {
    const missing = declared.filter((a) => !(a in UNLABELLED_BY_DESIGN) && auditActionCategory(a) === null);
    expect(missing).toEqual([]);
  });

  it("the exception list stays accurate: each entry is a declared action that is still unlabelled", () => {
    for (const action of Object.keys(UNLABELLED_BY_DESIGN)) {
      expect(declared, action).toContain(action);
      expect(auditActionCategory(action), action).toBeNull();
    }
  });

  it("every labelled action is a real AuditAction (no typo'd keys)", () => {
    const labelled = (Object.keys(AUDIT_CATEGORY_LABELS) as (keyof typeof AUDIT_CATEGORY_LABELS)[]).flatMap((c) =>
      actionsForCategory(c)
    );
    expect(labelled.filter((a) => !declared.includes(a))).toEqual([]);
  });
});
