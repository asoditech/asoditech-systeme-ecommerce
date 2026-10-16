import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { gtinEquivalents } from "@/lib/catalog/gs1";
import { formatGeneratedProductBarcode, GENERATED_BARCODE_MAX_SEQUENCE } from "@/lib/catalog/generated-barcode";

const ONE = BigInt(1);

/**
 * Allocation of generated product / variation barcodes (docs/adr/0061).
 *
 * The number comes from Tenant.nextProductBarcodeNumber via one atomic
 * `UPDATE … SET x = x + 1` (the tenant row stays locked until the caller's
 * transaction ends, so two concurrent generations never draw the same
 * number). A number whose code is already in use in the tenant — as any
 * barcode (exact or GTIN-equivalent spelling) or as a product / variation SKU
 * (the catalog refuses a barcode equal to another unit's SKU) — is skipped,
 * never reused. Saving is still protected by the existing unique index
 * `barcodes (tenantId, code)`; allocation is only the first line of defence.
 */

const MAX_ATTEMPTS = 50;

export class ProductBarcodeAllocationError extends Error {
  constructor(message = "Impossible de générer un code-barres unique pour le moment. Réessayez.") {
    super(message);
  }
}

export const PRODUCT_BARCODE_AUTO_DISABLED_MESSAGE =
  "La génération automatique des codes-barres est désactivée pour votre entreprise (Paramètres → Stock). La saisie manuelle reste possible.";

/** The tenant switch, read through the tenant-scoped client (RLS + extension). */
export async function isProductBarcodeAutoEnabled(client: PrismaTransactionClient | typeof prisma = prisma): Promise<boolean> {
  const settings = await client.businessSettings.findFirst({ select: { productBarcodeAutoEnabled: true } });
  return settings?.productBarcodeAutoEnabled === true;
}

async function claimSequence(tx: PrismaTransactionClient, tenantId: string): Promise<bigint> {
  const t = await tx.tenant.update({
    where: { id: tenantId },
    data: { nextProductBarcodeNumber: { increment: 1 } },
    select: { nextProductBarcodeNumber: true },
  });
  return t.nextProductBarcodeNumber - ONE;
}

async function codeIsTaken(tx: PrismaTransactionClient, code: string): Promise<boolean> {
  const spellings = [code, ...gtinEquivalents(code)];
  const [barcode, product, variation] = await Promise.all([
    tx.barcode.findFirst({ where: { code: { in: spellings } }, select: { id: true } }),
    tx.product.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: { id: true } }),
    tx.productVariation.findFirst({ where: { sku: { equals: code, mode: "insensitive" } }, select: { id: true } }),
  ]);
  return Boolean(barcode || product || variation);
}

/**
 * The next free generated code for `tenantId`, inside the caller's
 * transaction. When the caller also inserts the Barcode in that transaction
 * (variation generator), the row lock covers both.
 */
export async function allocateProductBarcode(tx: PrismaTransactionClient, tenantId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const sequence = await claimSequence(tx, tenantId);
    if (sequence > GENERATED_BARCODE_MAX_SEQUENCE) {
      throw new ProductBarcodeAllocationError("Plus aucun numéro de code-barres disponible pour cette entreprise.");
    }
    const code = formatGeneratedProductBarcode(sequence);
    if (!(await codeIsTaken(tx, code))) return code;
  }
  throw new ProductBarcodeAllocationError();
}

/**
 * After a backup restore: move the counter past the highest restored
 * generated code (« 20 » + 10 digits + check digit), so a new generation can
 * never hand out a restored code again. Never lowers the counter.
 */
export async function advanceProductBarcodeCounterPastExisting(tx: PrismaTransactionClient, tenantId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ max: bigint | null }[]>`
    SELECT MAX(CAST(SUBSTRING("code" FROM 3 FOR 10) AS BIGINT)) AS max
    FROM "barcodes"
    WHERE "tenantId" = ${tenantId} AND "code" ~ '^20[0-9]{11}$'`;
  const highest = rows[0]?.max ?? null;
  if (highest === null) return;
  await tx.tenant.updateMany({
    where: { id: tenantId, nextProductBarcodeNumber: { lte: highest } },
    data: { nextProductBarcodeNumber: highest + ONE },
  });
}
