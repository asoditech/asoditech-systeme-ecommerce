import "server-only";

import { PrismaClient } from "@prisma/client";

declare global {
  var __prismaRaw: PrismaClient | undefined;
}

/**
 * The single underlying `PrismaClient` connection pool — genuinely
 * unextended, no tenant scoping, no RLS session-variable management. Both
 * `prisma` and `prismaBase` (src/lib/prisma.ts) are built from this ONE
 * instance so they share the same pool; the difference between them is
 * entirely which extension is applied, never which connection they use.
 *
 * Lives in its own module (not src/lib/prisma.ts) so the tenant extension
 * and the RLS transaction wrapper (src/lib/tenant/extension.ts,
 * src/lib/tenant/rls.ts) can import it without a circular dependency on
 * src/lib/prisma.ts, which itself imports those.
 */
export const prismaRaw =
  global.__prismaRaw ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__prismaRaw = prismaRaw;
}
