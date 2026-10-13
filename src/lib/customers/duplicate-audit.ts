/**
 * Duplicate-customer AUDIT (read-only) — counts the customers that the
 * identity rule (./identity.ts: normalized name + normalized phone) would
 * consider ONE person but that exist as several rows (history from before
 * the rule, 2026-10-06). Pure: no database access, never merges or deletes.
 * Used by scripts/audit-customer-duplicates.ts and its tests.
 *
 * A group is per company (tenantId) — the same person in two companies is
 * never a duplicate. Customers without a valid phone or name never match
 * anyone (the rule's own exception), so they are counted apart.
 */
import { customerNameKey, customerPhoneKey } from "./identity";

export interface AuditCustomer {
  id: string;
  tenantId: string;
  fullName: string;
  phone: string | null;
  createdAt: Date;
}

export interface DuplicateGroup {
  tenantId: string;
  /** Oldest first — the row `findOrCreateCustomer` already reuses. */
  customerIds: string[];
}

export interface DuplicateAuditResult {
  scanned: number;
  /** No usable phone or name: excluded from matching by the rule itself. */
  unmatchable: number;
  groups: DuplicateGroup[];
  /** Rows beyond the first of each group. */
  surplusRows: number;
  byTenant: Record<string, { groups: number; surplusRows: number }>;
}

export function findDuplicateCustomerGroups(customers: readonly AuditCustomer[]): DuplicateAuditResult {
  const buckets = new Map<string, AuditCustomer[]>();
  let unmatchable = 0;
  for (const c of customers) {
    const phoneKey = customerPhoneKey(c.phone);
    const nameKey = customerNameKey(c.fullName);
    if (!phoneKey || !nameKey) {
      unmatchable++;
      continue;
    }
    const key = JSON.stringify([c.tenantId, phoneKey, nameKey]);
    const bucket = buckets.get(key) ?? [];
    bucket.push(c);
    buckets.set(key, bucket);
  }

  const groups: DuplicateGroup[] = [];
  const byTenant: DuplicateAuditResult["byTenant"] = {};
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const tenantId = bucket[0].tenantId;
    groups.push({ tenantId, customerIds: bucket.map((c) => c.id) });
    const t = (byTenant[tenantId] ??= { groups: 0, surplusRows: 0 });
    t.groups++;
    t.surplusRows += bucket.length - 1;
  }
  groups.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.customerIds[0].localeCompare(b.customerIds[0]));
  return {
    scanned: customers.length,
    unmatchable,
    groups,
    surplusRows: groups.reduce((n, g) => n + g.customerIds.length - 1, 0),
    byTenant,
  };
}
