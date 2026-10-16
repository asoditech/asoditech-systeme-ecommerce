import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
import { formatCustomerBarcode } from "./barcode";

/**
 * Allocation of automatic customer codes (docs/adr/0060).
 *
 * Effective only when BOTH hold: the platform granted the tenant
 * (Tenant.customerBarcodesGranted — written by platform admins only) AND the
 * tenant switched it on (BusinessSettings.customerBarcodeEnabled).
 *
 * The number comes from Tenant.nextCustomerBarcodeNumber via the same atomic
 * `UPDATE … SET x = x + 1` as display numbers: the tenant row stays locked
 * until the caller's transaction ends, so concurrent creations in one tenant
 * are serialised and can never draw the same number. The counter is never
 * reset — turning the feature off and on continues the sequence, and a number
 * consumed by a skipped collision is simply not reused.
 */

/** Numbers skipped in one allocation before giving up (collisions with product
 * identifiers or restored customer codes are rare — this bounds the loop). */
const MAX_ALLOCATION_ATTEMPTS = 25;

export class CustomerBarcodeAllocationError extends Error {
  constructor() {
    super("Impossible d'attribuer un code client unique pour le moment. Réessayez ; si le problème persiste, contactez le support.");
  }
}

/** The tenant switch, read through the tenant-scoped client (RLS + extension). */
export async function isCustomerBarcodeSwitchOn(client: PrismaTransactionClient | typeof prisma = prisma): Promise<boolean> {
  const settings = await client.businessSettings.findFirst({ select: { customerBarcodeEnabled: true } });
  return settings?.customerBarcodeEnabled === true;
}

/** The platform grant. `Tenant` is not tenant-scoped (it IS the tenant). */
export async function isCustomerBarcodeGranted(client: PrismaTransactionClient | typeof prisma, tenantId: string): Promise<boolean> {
  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { customerBarcodesGranted: true } });
  return tenant?.customerBarcodesGranted === true;
}

/** Is `code` already used by another identifier of this tenant (customer code,
 * product barcode, product or variation SKU)? Case-insensitive on product
 * identifiers, which are compared that way by the catalogue lookup. */
async function codeIsTaken(tx: PrismaTransactionClient, code: string): Promise<boolean> {
  const [customer, barcode, product, variation] = await Promise.all([
    tx.customer.findFirst({ where: { barcode: code }, select: { id: true } }),
    tx.barcode.findFirst({ where: { code: { equals: code, mode: "insensitive" } }, select: { id: true } }),
    tx.product.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: { id: true } }),
    tx.productVariation.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: { id: true } }),
  ]);
  return Boolean(customer || barcode || product || variation);
}

/**
 * The next free « CL-… » code for `tenantId`, inside the caller's transaction.
 * Must be called in the SAME transaction as the customer insert, so the
 * tenant-row lock covers both.
 */
export async function allocateCustomerBarcode(tx: PrismaTransactionClient, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const sequence = await claimTenantDisplayNumber(tx, tenantId, "customerBarcode");
    const code = formatCustomerBarcode(sequence);
    if (!(await codeIsTaken(tx, code))) return code;
  }
  throw new CustomerBarcodeAllocationError();
}

/**
 * After a backup restore: move the counter past the highest restored code so
 * no new customer can be given a restored customer's number. Never lowers it.
 * Codes are compared numerically (« CL-1000000 » > « CL-999999 »).
 */
export async function advanceCustomerBarcodeCounterPastExisting(tx: PrismaTransactionClient, tenantId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("barcode" FROM 4) AS BIGINT))::int AS max
    FROM "customers"
    WHERE "tenantId" = ${tenantId} AND "barcode" ~ '^CL-[0-9]+$'`;
  const highest = rows[0]?.max ?? null;
  if (highest === null) return;
  await tx.tenant.updateMany({
    where: { id: tenantId, nextCustomerBarcodeNumber: { lte: highest } },
    data: { nextCustomerBarcodeNumber: highest + 1 },
  });
}
