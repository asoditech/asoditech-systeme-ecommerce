import "server-only";

import { prisma, prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";
import { generateRawToken } from "@/lib/auth/tokens";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { env } from "@/lib/env";
import { variantLabel } from "@/lib/catalog/lookup";

/**
 * Product/variation QR-label identity — docs/adr/0042.
 *
 * A `qrToken` is the PUBLIC identity a printed label's QR code encodes,
 * resolved by the unauthenticated `/scan/[token]` route. Lazy by design:
 * nothing generates one until a label is actually requested (the "Imprimer
 * l'étiquette" print page, `/produits/[id]/etiquette`) — never a bulk
 * backfill, never one for every variation just because its product page was
 * opened. Reuses the barcode-system's threat model (opaque, non-guessable,
 * printed on a physical package — not a secret bearer token), so the token
 * is stored in the clear and can be read back to reprint the same label.
 */

/** Ensures `product.qrToken` exists, generating one on first use. Idempotent under a race (unique-constraint retry, same pattern as `addBarcode`). */
export async function ensureProductQrToken(productId: string): Promise<string> {
  const existing = await prisma.product.findUnique({ where: { id: productId }, select: { qrToken: true } });
  if (!existing) throw new Error("Produit introuvable.");
  if (existing.qrToken) return existing.qrToken;
  return generateAndSet((token) => prisma.product.update({ where: { id: productId }, data: { qrToken: token } }), productId, "product");
}

/** Same as `ensureProductQrToken`, for one specific variation — the physical unit a label is actually stuck on. */
export async function ensureVariationQrToken(variationId: string): Promise<string> {
  const existing = await prisma.productVariation.findUnique({ where: { id: variationId }, select: { qrToken: true } });
  if (!existing) throw new Error("Variante introuvable.");
  if (existing.qrToken) return existing.qrToken;
  return generateAndSet((token) => prisma.productVariation.update({ where: { id: variationId }, data: { qrToken: token } }), variationId, "variation");
}

async function generateAndSet(write: (token: string) => Promise<unknown>, ownerId: string, kind: "product" | "variation"): Promise<string> {
  // A fresh 256-bit token collides with an existing one only in theory —
  // retry once on the (practically unreachable) unique-constraint race.
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = generateRawToken();
    try {
      await write(token);
      return token;
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error(`Impossible de générer un jeton d'étiquette pour ce ${kind === "product" ? "produit" : "variante"} (${ownerId}).`);
}

/** The absolute, scannable URL a label's QR code encodes. */
export function scanUrl(token: string): string {
  return new URL(`/scan/${token}`, env.APP_URL).toString();
}

export interface ScanResult {
  kind: "product" | "variation";
  productName: string;
  variantAttributes: Record<string, string> | null;
  variantLabel: string | null;
  sku: string;
  primaryBarcode: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  companyName: string | null;
}

/**
 * Resolves a scanned token to the SAFE, PUBLIC subset of one product or
 * variation's data — no cost/price/supplier/internal fields, ever (the
 * shape above is the entire contract; nothing else is ever selected).
 * Unscoped by necessity, exactly like the invitation/password-reset token
 * lookups: the token itself is the only thing that determines which
 * tenant's row this is, there being no session to derive one from. A
 * tenant-A token can only ever resolve tenant-A's own row — never leaks
 * whether some OTHER tenant owns a similar-looking token, since a miss on
 * BOTH tables (product and variation) all collapse to the same `null`.
 */
export async function resolveScanToken(token: string): Promise<ScanResult | null> {
  if (!token || token.length < 16) return null; // cheap reject before touching the DB
  return runUnscoped("scan-token-lookup", async () => {
    const variation = await prismaBase.productVariation.findUnique({
      where: { qrToken: token },
      select: {
        sku: true,
        attributes: true,
        tenantId: true,
        product: {
          select: {
            name: true,
            category: { select: { name: true } },
          },
        },
        barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
        imageUrl: true,
      },
    });
    if (variation) {
      const attrs = (variation.attributes as Record<string, string> | null) ?? null;
      return {
        kind: "variation",
        productName: variation.product.name,
        variantAttributes: attrs,
        variantLabel: variantLabel(attrs),
        sku: variation.sku,
        primaryBarcode: variation.barcodes[0]?.code ?? null,
        categoryName: variation.product.category?.name ?? null,
        imageUrl: variation.imageUrl,
        companyName: await companyNameFor(variation.tenantId),
      };
    }

    const product = await prismaBase.product.findUnique({
      where: { qrToken: token },
      select: {
        name: true,
        sku: true,
        tenantId: true,
        category: { select: { name: true } },
        barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
        images: { orderBy: { position: "asc" }, select: { url: true }, take: 1 },
      },
    });
    if (!product) return null;
    return {
      kind: "product",
      productName: product.name,
      variantAttributes: null,
      variantLabel: null,
      sku: product.sku,
      primaryBarcode: product.barcodes[0]?.code ?? null,
      categoryName: product.category?.name ?? null,
      imageUrl: product.images[0]?.url ?? null,
      companyName: await companyNameFor(product.tenantId),
    };
  });
}

/** `BusinessSettings.companyName` for the token's OWN tenant — never the caller's (there isn't one here). */
async function companyNameFor(tenantId: string): Promise<string | null> {
  const settings = await prismaBase.businessSettings.findUnique({ where: { tenantId }, select: { companyName: true } });
  return settings?.companyName?.trim() || null;
}
