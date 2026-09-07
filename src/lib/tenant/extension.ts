import "server-only";

import { Prisma } from "@prisma/client";
import { resolveActiveTenant, resolveActiveTenantForCreate } from "@/lib/tenant/resolve";
import { wrapOperationWithBypass, wrapOperationWithTenant } from "@/lib/tenant/rls";

/**
 * Phase 2 tenant isolation extension (docs/adr/0024-multi-tenant-context.md).
 *
 * Wraps every operation on a tenant-owned model so that:
 *  - reads / updates / deletes are filtered to the active tenant;
 *  - creates are forced into the active tenant;
 *  - a caller that passes an explicit, DIFFERENT tenantId (in `where`,
 *    `data`, `create` or `update`) is rejected — removing the "silently
 *    read or write another tenant's rows" failure mode.
 *
 * Phase 3 (docs/adr/0025-multi-tenant-isolation.md) tightens one thing: a
 * create-family op (create/createMany/createManyAndReturn/upsert) with NO
 * resolvable tenant (no directive, no session) now throws instead of
 * silently landing in the bootstrap tenant — see
 * `resolveActiveTenantForCreate`.
 *
 * Phase 4 (docs/adr/0026-multi-tenant-rls.md) adds two things:
 *  - every operation is wrapped (`wrapOperationWithTenant`/
 *    `wrapOperationWithBypass`, src/lib/tenant/rls.ts) so the DB-level RLS
 *    policy on each table sees the correct `app.tenant_id`/
 *    `app.bypass_rls` GUC — this is now the REAL enforcement boundary, not
 *    just this app-level filter;
 *  - `stampNestedWrites` recursively stamps `tenantId` onto nested
 *    relation creates (`order.create({ data: { items: { create: [...] } } })`)
 *    — a Prisma extension limitation this app previously relied on the
 *    Phase 1 column default to paper over (safe only for the bootstrap
 *    tenant). Nested `include` READS need no equivalent fix: they run as
 *    extra SQL on the SAME connection/transaction as the outer call, which
 *    Phase 4's RLS wrapping already covers, so the DB itself filters them.
 */

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/** PascalCase names of every model carrying a `tenantId` column. */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "tenantId"))
    .map((model) => model.name)
);

// Operations whose args carry a filter `where` we must narrow to the tenant.
const WHERE_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
]);

// Operations that persist a `data` payload we must stamp with the tenant.
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

function foreignTenant(value: unknown, tenantId: string): string | null {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { tenantId?: unknown }).tenantId === "string" &&
    (value as { tenantId: string }).tenantId !== tenantId
  ) {
    return (value as { tenantId: string }).tenantId;
  }
  return null;
}

function rejectForeignTenant(value: unknown, tenantId: string, context: string): void {
  const other = foreignTenant(value, tenantId);
  if (other !== null) {
    throw new TenantIsolationError(
      `${context}: refusing an operation aimed at tenant "${other}" from tenant "${tenantId}".`
    );
  }
}

function stampData<T>(data: T, tenantId: string, context: string): T {
  if (Array.isArray(data)) {
    return data.map((row) => {
      rejectForeignTenant(row, tenantId, context);
      return { ...(row as Record<string, unknown>), tenantId };
    }) as T;
  }
  rejectForeignTenant(data, tenantId, context);
  return { ...(data as Record<string, unknown>), tenantId } as T;
}

// ---------------------------------------------------------------------------
// Nested-write stamping (Phase 4) — see the module doc comment above.
// ---------------------------------------------------------------------------

interface RelationField {
  readonly name: string;
  readonly relatedModel: string;
}

/** Per model, its relation fields that point at ANOTHER tenant-scoped
 * model — the only ones a nested `create`/`createMany`/`connectOrCreate`
 * could possibly need stamped. Built once from the DMMF. */
const NESTED_RELATION_FIELDS: ReadonlyMap<string, readonly RelationField[]> = new Map(
  Prisma.dmmf.datamodel.models.map((model) => [
    model.name,
    model.fields
      .filter((field) => field.kind === "object" && TENANT_SCOPED_MODELS.has(field.type))
      .map((field) => ({ name: field.name, relatedModel: field.type })),
  ])
);

function stampNestedRow(row: unknown, tenantId: string, relatedModel: string, context: string): void {
  if (row === null || typeof row !== "object") return;
  rejectForeignTenant(row, tenantId, context);
  (row as Record<string, unknown>).tenantId = tenantId;
  // A nested create can itself carry further nested creates (e.g. two
  // levels down) — recurse using the CHILD model's own relation fields.
  stampNestedWrites(relatedModel, row, tenantId, context);
}

function stampRelationValue(value: unknown, tenantId: string, relatedModel: string, context: string): void {
  if (value === null || typeof value !== "object") return;
  const v = value as Record<string, unknown>;

  if (v.create !== undefined) {
    for (const row of Array.isArray(v.create) ? v.create : [v.create]) {
      stampNestedRow(row, tenantId, relatedModel, context);
    }
  }
  if (v.createMany !== undefined && typeof v.createMany === "object") {
    const cm = (v.createMany as Record<string, unknown>).data;
    for (const row of Array.isArray(cm) ? cm : cm !== undefined ? [cm] : []) {
      stampNestedRow(row, tenantId, relatedModel, context);
    }
  }
  if (v.connectOrCreate !== undefined) {
    for (const coc of Array.isArray(v.connectOrCreate) ? v.connectOrCreate : [v.connectOrCreate]) {
      if (coc !== null && typeof coc === "object" && "create" in coc) {
        stampNestedRow((coc as Record<string, unknown>).create, tenantId, relatedModel, context);
      }
    }
  }
}

/** Walks `data`'s relation fields (per the model's DMMF) and stamps
 * `tenantId` onto any nested create the Prisma extension can't otherwise
 * reach — see the module doc comment. No-op for a model/data shape with
 * nothing to recurse into. */
function stampNestedWrites(model: string, data: unknown, tenantId: string, context: string): void {
  const fields = NESTED_RELATION_FIELDS.get(model);
  if (!fields || fields.length === 0 || data === null || typeof data !== "object") return;
  for (const row of Array.isArray(data) ? data : [data]) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    for (const field of fields) {
      if (r[field.name] !== undefined) {
        stampRelationValue(r[field.name], tenantId, field.relatedModel, context);
      }
    }
  }
}

export const tenantExtension = Prisma.defineExtension({
  name: "tenant-isolation",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        // A create-family op (including upsert, which may take the create
        // branch) gets the stricter resolver: no directive + no session is
        // no longer a silent "default" fallback for a NEW row outside
        // tests (docs/adr/0025, Phase 3).
        const isCreateFamily = CREATE_OPS.has(operation) || operation === "upsert";
        const { tenantId, source } = isCreateFamily
          ? await resolveActiveTenantForCreate(model, operation)
          : await resolveActiveTenant(model, operation);
        if (source === "unscoped" || tenantId === null) {
          // Deliberately trusted context (login, webhook self-lookup, …) —
          // still runs under the DB-level RLS bypass GUC, never a raw
          // unwrapped connection (docs/adr/0026).
          return wrapOperationWithBypass(query, args);
        }

        const context = `${model}.${operation}`;
        const a = { ...((args as Record<string, unknown>) ?? {}) };

        if (WHERE_OPS.has(operation)) {
          const where = (a.where as Record<string, unknown> | undefined) ?? undefined;
          rejectForeignTenant(where, tenantId, context);
          // Guard against relocating a row to another tenant via update data.
          rejectForeignTenant(a.data, tenantId, context);
          a.where = { ...(where ?? {}), tenantId };
          return wrapOperationWithTenant(tenantId, query, a);
        }

        if (CREATE_OPS.has(operation)) {
          a.data = stampData(a.data, tenantId, context);
          stampNestedWrites(model, a.data, tenantId, context);
          return wrapOperationWithTenant(tenantId, query, a);
        }

        if (operation === "upsert") {
          const where = (a.where as Record<string, unknown> | undefined) ?? undefined;
          rejectForeignTenant(where, tenantId, context);
          a.where = { ...(where ?? {}), tenantId };
          a.create = stampData(a.create, tenantId, context);
          stampNestedWrites(model, a.create, tenantId, context);
          rejectForeignTenant(a.update, tenantId, context);
          return wrapOperationWithTenant(tenantId, query, a);
        }

        // Unknown / future operation: scope a `where` if present, else pass.
        if (a.where !== undefined) {
          rejectForeignTenant(a.where, tenantId, context);
          a.where = { ...(a.where as Record<string, unknown>), tenantId };
          return wrapOperationWithTenant(tenantId, query, a);
        }
        return wrapOperationWithTenant(tenantId, query, args);
      },
    },
  },
});
