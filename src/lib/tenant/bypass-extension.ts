import "server-only";

import { Prisma } from "@prisma/client";
import { wrapOperationWithBypass } from "@/lib/tenant/rls";

/**
 * `prismaBase`'s extension (Phase 4 — docs/adr/0026-multi-tenant-rls.md).
 *
 * `prismaBase` is the "raw, no tenant FILTERING, sees everything" client —
 * used only where scoping must not apply (session resolution, the webhook
 * routes' cross-tenant Integration lookup, the seed script, test fixtures
 * spanning multiple tenants). Before Phase 4 that was true by construction:
 * an unextended `PrismaClient` simply issues the query as written.
 *
 * Now that every tenant-scoped table has RLS enabled, that's no longer
 * true by construction — a connection with no `app.tenant_id`/
 * `app.bypass_rls` GUC set sees ZERO rows on those tables (default-deny),
 * which would silently break `prismaBase`'s own legitimate uses (a session
 * lookup's nested `include: { user: true }`, the webhook routes' `findMany`
 * across every tenant's `Integration` rows, `resetDb()`, …). This
 * extension is the fix: every operation — including one that touches a
 * model with no `tenantId` column at all, like `Session` — is wrapped so
 * the RLS bypass GUC is set first. It does NOT do any app-level filtering
 * or stamping — `prismaBase` callers are trusted to already be one of the
 * narrow, audited cases the ADR documents.
 */
export const bypassExtension = Prisma.defineExtension({
  name: "rls-bypass",
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        return wrapOperationWithBypass(query, args);
      },
    },
  },
});
