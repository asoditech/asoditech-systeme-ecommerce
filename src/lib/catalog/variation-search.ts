import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveActiveTenantIdForRawSql } from "@/lib/tenant/resolve";
import { runRawBatchWithTenant } from "@/lib/tenant/rls";

/**
 * Ids of the variations whose OPTION VALUES contain `query` (case-insensitive)
 * — e.g. "Rouge" or "XL" in `{"Couleur":"Rouge","Taille":"XL"}`. Only the
 * values are searched (`jsonb_each_text`), never the keys, so "Taille" does
 * not match every variation.
 *
 * Raw SQL (a JSONB value search has no Prisma equivalent), made tenant-safe
 * exactly like src/lib/queries/inventory.ts: an explicit `tenantId` predicate
 * AND the RLS `app.tenant_id` GUC via `runRawBatchWithTenant`. Bounded by
 * `limit`; no index needed at the current catalogue size.
 */
export async function variationIdsMatchingOptionValue(query: string, limit = 200): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const tenantId = await resolveActiveTenantIdForRawSql("catalog.variationIdsMatchingOptionValue");
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const [rows] = (await runRawBatchWithTenant(tenantId, [
    prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT v.id
      FROM "product_variations" v
      WHERE v."tenantId" = ${tenantId}
        AND jsonb_typeof(v."attributes") = 'object'
        AND EXISTS (
          SELECT 1 FROM jsonb_each_text(v."attributes") AS e(key, value)
          WHERE e.value ILIKE ${pattern}
        )
      ORDER BY v.id
      LIMIT ${limit}`),
  ])) as [{ id: string }[]];
  return rows.map((r) => r.id);
}
