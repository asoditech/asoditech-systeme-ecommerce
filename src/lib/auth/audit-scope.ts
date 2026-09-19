import type { Prisma } from "@prisma/client";
import type { ChannelAccess } from "@/lib/auth/effective-access";

/**
 * Audit-log read scope — docs/adr/0039. The audit log is a SHARED surface: it
 * holds Online (orders, shipments, integrations, commissions…), Offline
 * (sales, sale returns) and shared events (products, stock, users, settings).
 * A user with no OFFLINE channel must not read `sale.created`, and a user
 * with no ONLINE channel must not read `order.status_changed` — an audit
 * line names the record and often its amounts.
 *
 * Classification is by `entityType` / action prefix. Anything not listed is
 * SHARED and visible to everyone holding `audit.view`.
 */

const ONLINE_ENTITY_TYPES = [
  "Order",
  "Shipment",
  "ShippingProvider",
  "DeliveryManifest",
  "DeliveryCityMapping",
  "Refund",
  "OrderReturn",
  "CommissionAgent",
  "CommissionStatement",
  "Integration",
  "SyncRun",
  "MarketingCampaign",
  "MarketingChannel",
];
const ONLINE_ACTION_PREFIXES = ["order.", "shipment.", "delivery.", "commission.", "integration.", "marketing_"];

const OFFLINE_ENTITY_TYPES = ["Sale", "SaleReturn"];
const OFFLINE_ACTION_PREFIXES = ["sale."];

function domainCondition(entityTypes: string[], prefixes: string[]): Prisma.AuditEventWhereInput {
  return {
    OR: [{ entityType: { in: entityTypes } }, ...prefixes.map((p) => ({ action: { startsWith: p } }))],
  };
}

/**
 * `where` fragment to AND into any AuditEvent query. OWNER/ADMIN (global) and
 * users with both activities get no restriction.
 */
export function auditScopeWhere(channels: Pick<ChannelAccess, "global" | "online" | "offline">): Prisma.AuditEventWhereInput {
  if (channels.global || (channels.online && channels.offline)) return {};
  const excluded: Prisma.AuditEventWhereInput[] = [];
  if (!channels.online) excluded.push(domainCondition(ONLINE_ENTITY_TYPES, ONLINE_ACTION_PREFIXES));
  if (!channels.offline) excluded.push(domainCondition(OFFLINE_ENTITY_TYPES, OFFLINE_ACTION_PREFIXES));
  return { NOT: excluded };
}
