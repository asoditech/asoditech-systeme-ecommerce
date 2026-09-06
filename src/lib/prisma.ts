import { PrismaClient } from "@prisma/client";
import { tenantExtension } from "@/lib/tenant/extension";

declare global {
  var __prismaBase: PrismaClient | undefined;
}

/**
 * Raw client — NO tenant scoping. Use only where scoping must not apply and
 * would recurse: session resolution (src/lib/auth/session.ts), the seed
 * script, and test DB reset. Everything else uses the extended `prisma`.
 */
export const prismaBase =
  global.__prismaBase ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__prismaBase = prismaBase;
}

/**
 * The application Prisma client. Every operation on a tenant-owned model is
 * automatically scoped to the active tenant by `tenantExtension`
 * (docs/adr/0024-multi-tenant-context.md). The tenant comes from an
 * explicit `runWithTenant` directive, else the logged-in user's session,
 * else the bootstrap tenant.
 */
export const prisma = prismaBase.$extends(tenantExtension);

/**
 * The client type handed to an interactive `prisma.$transaction(async (tx) => …)`
 * callback. Because `prisma` is `$extends`-wrapped, this is NOT
 * `Prisma.TransactionClient` — helpers that accept a transaction client must
 * use this type so the extension's tenant scoping also applies to their
 * queries.
 */
export type PrismaTransactionClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
