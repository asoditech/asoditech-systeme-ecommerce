import "server-only";

import { Prisma } from "@prisma/client";
import { resolveActiveTenant } from "@/lib/tenant/resolve";

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
 * It does NOT reach nested reads/writes (`include`, nested `create`) — a
 * Prisma client-extension limitation. Those rely on the Phase 1 column
 * default and are closed by RLS in a later phase (see the ADR).
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

export const tenantExtension = Prisma.defineExtension({
  name: "tenant-isolation",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const { tenantId, source } = await resolveActiveTenant(model, operation);
        if (source === "unscoped" || tenantId === null) {
          // Deliberately trusted context (login, webhook self-lookup, …).
          return query(args);
        }

        const context = `${model}.${operation}`;
        const a = { ...((args as Record<string, unknown>) ?? {}) };

        if (WHERE_OPS.has(operation)) {
          const where = (a.where as Record<string, unknown> | undefined) ?? undefined;
          rejectForeignTenant(where, tenantId, context);
          // Guard against relocating a row to another tenant via update data.
          rejectForeignTenant(a.data, tenantId, context);
          a.where = { ...(where ?? {}), tenantId };
          return query(a);
        }

        if (CREATE_OPS.has(operation)) {
          a.data = stampData(a.data, tenantId, context);
          return query(a);
        }

        if (operation === "upsert") {
          const where = (a.where as Record<string, unknown> | undefined) ?? undefined;
          rejectForeignTenant(where, tenantId, context);
          a.where = { ...(where ?? {}), tenantId };
          a.create = stampData(a.create, tenantId, context);
          rejectForeignTenant(a.update, tenantId, context);
          return query(a);
        }

        // Unknown / future operation: scope a `where` if present, else pass.
        if (a.where !== undefined) {
          rejectForeignTenant(a.where, tenantId, context);
          a.where = { ...(a.where as Record<string, unknown>), tenantId };
          return query(a);
        }
        return query(args);
      },
    },
  },
});
