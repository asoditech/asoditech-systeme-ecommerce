import "server-only";

import type { PrismaTransactionClient } from "@/lib/prisma";

/**
 * Per-tenant DISPLAY numbering (Phase 3 — docs/adr/0025-multi-tenant-isolation.md).
 *
 * `Order.orderNumber` / `StockTransfer.transferNumber` / `StocktakeSession.
 * sessionNumber` stay exactly what they always were: a single GLOBAL
 * autoincrement sequence, shared across every tenant, never renumbered.
 * That's the internal identity — untouched by this file.
 *
 * What a user actually sees ("CMD-000123") should instead count up from 1
 * within their own tenant, so tenant B's first order doesn't visibly start
 * at some triple-digit number tenant A already used. `Tenant.nextOrderNumber`
 * (and the two siblings) hold "the next value to hand out", claimed here via
 * a single row-locked `UPDATE … SET x = x + 1 … RETURNING x` — atomic under
 * concurrent creates for the same tenant, with no separate advisory lock.
 *
 * The result is stored on the row's own `displayNumber` column (nullable —
 * null on every pre-Phase-3 row). `src/lib/format.ts`'s formatters fall
 * back to the legacy global number when `displayNumber` is null, so
 * history is never rewritten.
 */
export type TenantSequenceKind = "order" | "transfer" | "stocktake";

/**
 * Claims and returns the next per-tenant display number for `kind`. Safe to
 * call standalone or inside a `$transaction` — `client` accepts either
 * `prisma` or a `tx`, since the increment is a single atomic UPDATE either
 * way. `Tenant` itself is never tenant-scoped (it IS the tenant), so this
 * passes through the isolation extension untouched regardless of which
 * tenant is active.
 */
export async function claimTenantDisplayNumber(
  client: PrismaTransactionClient,
  tenantId: string,
  kind: TenantSequenceKind
): Promise<number> {
  switch (kind) {
    case "order": {
      const t = await client.tenant.update({
        where: { id: tenantId },
        data: { nextOrderNumber: { increment: 1 } },
        select: { nextOrderNumber: true },
      });
      return t.nextOrderNumber - 1;
    }
    case "transfer": {
      const t = await client.tenant.update({
        where: { id: tenantId },
        data: { nextTransferNumber: { increment: 1 } },
        select: { nextTransferNumber: true },
      });
      return t.nextTransferNumber - 1;
    }
    case "stocktake": {
      const t = await client.tenant.update({
        where: { id: tenantId },
        data: { nextStocktakeNumber: { increment: 1 } },
        select: { nextStocktakeNumber: true },
      });
      return t.nextStocktakeNumber - 1;
    }
  }
}
