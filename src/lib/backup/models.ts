import "server-only";

/**
 * The ordered catalogue of what a tenant backup contains
 * (docs/adr/0034-backup-and-portability.md).
 *
 * `BACKUP_MODELS` is in INSERT (dependency) order — every model's foreign
 * keys point only at models earlier in the list, with the single exception
 * of `Category.parentId` (self-reference), handled by `deferredFks` +
 * a second patch pass in the restore engine. DELETE order is the exact
 * reverse, restricted to `strategy: "replace"` models.
 *
 * This is data, not logic — `export.ts` / `import.ts` interpret it. Adding
 * a model to a backup = one entry here + (if needed) a manifest version
 * bump.
 */

export type RestoreStrategy =
  // Wipe every row of this model for the tenant, then insert the backup's.
  | "replace"
  // User accounts: never deleted (avoids locking anyone out). Matched by
  // (tenantId, email); existing rows get safe fields updated, missing rows
  // are created login-disabled (no passwordHash in a backup — see the ADR).
  | "mergeUser"
  // BusinessSettings: exactly one row per tenant — upserted by tenantId.
  | "upsertSettings"
  // AuditEvent: append-only history — never wiped; backup rows not already
  // present (by id) are inserted.
  | "appendAudit";

export interface BackupModel {
  /** Prisma model name (DMMF / PascalCase). */
  model: string;
  /** `prisma.<accessor>` — camelCase model accessor. */
  accessor: string;
  /** Stable key used in the package `data` map and `manifest.counts`
   * (the `@@map` table name — plural snake_case, matches the DB). */
  key: string;
  strategy: RestoreStrategy;
  /** FK columns inserted as NULL then patched in a second pass (a row may
   * reference another row of the same model that sorts after it). */
  deferredFks?: readonly string[];
}

export const BACKUP_MODELS: readonly BackupModel[] = [
  { model: "User", accessor: "user", key: "users", strategy: "mergeUser" },
  { model: "BusinessSettings", accessor: "businessSettings", key: "business_settings", strategy: "upsertSettings" },
  { model: "Customer", accessor: "customer", key: "customers", strategy: "replace" },
  { model: "CustomerAddress", accessor: "customerAddress", key: "customer_addresses", strategy: "replace" },
  { model: "Category", accessor: "category", key: "categories", strategy: "replace", deferredFks: ["parentId"] },
  { model: "Product", accessor: "product", key: "products", strategy: "replace" },
  { model: "ProductImage", accessor: "productImage", key: "product_images", strategy: "replace" },
  { model: "ProductVariation", accessor: "productVariation", key: "product_variations", strategy: "replace" },
  { model: "Warehouse", accessor: "warehouse", key: "warehouses", strategy: "replace" },
  { model: "InventoryItem", accessor: "inventoryItem", key: "inventory_items", strategy: "replace" },
  { model: "MarketingChannel", accessor: "marketingChannel", key: "marketing_channels", strategy: "replace" },
  { model: "MarketingCampaign", accessor: "marketingCampaign", key: "marketing_campaigns", strategy: "replace" },
  { model: "CommissionAgent", accessor: "commissionAgent", key: "commission_agents", strategy: "replace" },
  { model: "CommissionStatement", accessor: "commissionStatement", key: "commission_statements", strategy: "replace" },
  { model: "ShippingProvider", accessor: "shippingProvider", key: "shipping_providers", strategy: "replace" },
  { model: "DeliveryCityMapping", accessor: "deliveryCityMapping", key: "delivery_city_mappings", strategy: "replace" },
  { model: "DeliveryManifest", accessor: "deliveryManifest", key: "delivery_manifests", strategy: "replace" },
  { model: "Order", accessor: "order", key: "orders", strategy: "replace" },
  { model: "OrderItem", accessor: "orderItem", key: "order_items", strategy: "replace" },
  { model: "OrderConfirmationAttempt", accessor: "orderConfirmationAttempt", key: "order_confirmation_attempts", strategy: "replace" },
  { model: "Refund", accessor: "refund", key: "refunds", strategy: "replace" },
  { model: "Shipment", accessor: "shipment", key: "shipments", strategy: "replace" },
  { model: "StockTransfer", accessor: "stockTransfer", key: "stock_transfers", strategy: "replace" },
  { model: "StockTransferLine", accessor: "stockTransferLine", key: "stock_transfer_lines", strategy: "replace" },
  { model: "StocktakeSession", accessor: "stocktakeSession", key: "stocktake_sessions", strategy: "replace" },
  {
    model: "InventoryMovement",
    accessor: "inventoryMovement",
    key: "inventory_movements",
    strategy: "replace",
    deferredFks: ["orderId", "stockTransferId", "stocktakeSessionId"],
  },
  {
    model: "StocktakeLine",
    accessor: "stocktakeLine",
    key: "stocktake_lines",
    strategy: "replace",
    deferredFks: ["appliedMovementId"],
  },
  { model: "CommissionEntry", accessor: "commissionEntry", key: "commission_entries", strategy: "replace" },
  { model: "ExpenseCategory", accessor: "expenseCategory", key: "expense_categories", strategy: "replace" },
  { model: "Expense", accessor: "expense", key: "expenses", strategy: "replace" },
  { model: "Integration", accessor: "integration", key: "integrations", strategy: "replace" },
  { model: "AuditEvent", accessor: "auditEvent", key: "audit_events", strategy: "appendAudit" },
] as const;

/** `key` → descriptor. */
export const BACKUP_MODELS_BY_KEY: ReadonlyMap<string, BackupModel> = new Map(
  BACKUP_MODELS.map((m) => [m.key, m])
);

type Row = Record<string, unknown>;

const CONFIG_SECRET_KEY = /secret|token|password|passwd|\bpin\b|api[_-]?key|access[_-]?key|credential|client[_-]?secret/i;

/** Defensive scrub of a (documented non-secret) `config` JSON blob — drops
 * any key that looks like a credential, at any depth. Returns a copy. */
export function scrubConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubConfig);
  if (value && typeof value === "object") {
    const out: Row = {};
    for (const [k, v] of Object.entries(value as Row)) {
      if (CONFIG_SECRET_KEY.test(k)) continue;
      out[k] = scrubConfig(v);
    }
    return out;
  }
  return value;
}

/**
 * Strip secret / cross-tenant fields from a row BEFORE it is written to a
 * backup. Never mutates the input. Keep in sync with
 * `SANITIZED_FIELDS` in constants.ts.
 */
export function sanitizeForExport(model: string, row: Row): Row {
  const out: Row = { ...row };
  switch (model) {
    case "User":
      delete out.passwordHash;
      delete out.isPlatformAdmin;
      break;
    case "Integration":
      delete out.credentialsEncrypted;
      if (out.config != null) out.config = scrubConfig(out.config);
      break;
    case "ShippingProvider":
      delete out.credentialsEncrypted;
      if (out.config != null) out.config = scrubConfig(out.config);
      break;
  }
  return out;
}

/**
 * Adjust a row coming FROM a backup before it is inserted — connectors must
 * always come back requiring reconnection, never with a stale "connected"
 * state or a credentials pointer.
 */
export function patchForRestore(model: string, row: Row): Row {
  const out: Row = { ...row };
  delete out.tenantId; // the tenant extension re-stamps the ACTIVE tenant
  switch (model) {
    case "User":
      // A backup carries no passwordHash. An account that already exists
      // keeps its own; a NEW one is created login-disabled (see import.ts).
      delete out.passwordHash;
      delete out.isPlatformAdmin;
      break;
    case "Integration":
      out.status = "DECONNECTE";
      out.credentialsEncrypted = null;
      out.lastConnectionCheckAt = null;
      out.lastSyncAt = null;
      out.lastError = null;
      break;
    case "ShippingProvider":
      out.credentialsEncrypted = null;
      out.connectionStatus = out.type === "API" ? "DECONNECTE" : null;
      out.lastConnectionCheckAt = null;
      out.lastSyncAt = null;
      out.lastError = null;
      break;
  }
  return out;
}

/** Drop `null`-valued keys (required so an optional JSON column falls to
 * its column default rather than a rejected `null` literal) and lift the
 * deferred-FK columns out for the second pass. */
export function splitRowForInsert(
  row: Row,
  deferredFks: readonly string[] | undefined
): { insert: Row; deferred: Row } {
  const insert: Row = {};
  const deferred: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    if (deferredFks?.includes(k)) {
      deferred[k] = v;
      continue;
    }
    insert[k] = v;
  }
  return { insert, deferred };
}
