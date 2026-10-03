import "server-only";

import type { Prisma, ProductStatus, RecordSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { productSearchWhere } from "@/lib/queries/products";
import type { ExportPlatform, ExportProduct } from "@/lib/catalog/export/model";

/**
 * Database side of the product CSV export (docs/adr/0054). Every query goes
 * through the tenant-scoped `prisma` client (Prisma extension + RLS): an id
 * from another tenant is simply not found, so it can never be exported.
 */

export const EXPORT_CANDIDATE_LIMIT = 1000;

export interface ExportFilters {
  q?: string;
  /** Default ACTIF — inactive (ARCHIVE) and draft products are excluded unless asked for. */
  status?: ProductStatus | "all";
  categoryId?: string;
  type?: "simple" | "variable";
  stock?: "in" | "out";
  /** YYYY-MM-DD, inclusive, on the ASODITECH creation date. */
  createdFrom?: string;
  createdTo?: string;
  /** Default INTERNE — a product imported from a store already lives there. */
  source?: RecordSource | "all";
  /** Only products not yet published to this platform from ASODITECH. */
  notPublishedTo?: ExportPlatform;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER: Record<ExportPlatform, "WOOCOMMERCE" | "SHOPIFY"> = { woocommerce: "WOOCOMMERCE", shopify: "SHOPIFY" };

export function exportFilterWhere(f: ExportFilters): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  if (f.q?.trim()) and.push({ OR: productSearchWhere(f.q.trim()) });
  const status = f.status ?? "ACTIF";
  if (status !== "all") and.push({ status });
  const source = f.source ?? "INTERNE";
  if (source !== "all") and.push({ source });
  if (f.categoryId) and.push({ categoryId: f.categoryId });
  if (f.type === "variable") and.push({ variations: { some: {} } });
  if (f.type === "simple") and.push({ variations: { none: {} } });
  const inStock: Prisma.ProductWhereInput = {
    OR: [
      { inventoryItems: { some: { quantityOnHand: { gt: 0 } } } },
      { variations: { some: { inventoryItems: { some: { quantityOnHand: { gt: 0 } } } } } },
    ],
  };
  if (f.stock === "in") and.push(inStock);
  if (f.stock === "out") and.push({ NOT: inStock });
  if (f.createdFrom && DAY.test(f.createdFrom)) and.push({ createdAt: { gte: new Date(`${f.createdFrom}T00:00:00`) } });
  if (f.createdTo && DAY.test(f.createdTo)) and.push({ createdAt: { lte: new Date(`${f.createdTo}T23:59:59.999`) } });
  if (f.notPublishedTo) and.push({ publications: { none: { provider: PROVIDER[f.notPublishedTo] } } });
  return and.length ? { AND: and } : {};
}

export interface ExportCandidate {
  id: string;
  name: string;
  sku: string;
  status: ProductStatus;
  category: string | null;
  variationCount: number;
  imageCount: number;
  createdAt: Date;
  publishedTo: ExportPlatform[];
}

/** The filtered list the user selects from (capped — narrow the filters beyond it). */
export async function listExportCandidates(f: ExportFilters): Promise<{ rows: ExportCandidate[]; total: number }> {
  const where = exportFilterWhere(f);
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ name: "asc" }, { sku: "asc" }],
      take: EXPORT_CANDIDATE_LIMIT,
      select: {
        id: true,
        name: true,
        sku: true,
        status: true,
        createdAt: true,
        category: { select: { name: true } },
        publications: { select: { provider: true } },
        _count: { select: { variations: true, images: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      sku: r.sku,
      status: r.status,
      category: r.category?.name ?? null,
      variationCount: r._count.variations,
      imageCount: r._count.images,
      createdAt: r.createdAt,
      publishedTo: r.publications.map((p) => (p.provider === "WOOCOMMERCE" ? "woocommerce" : "shopify")),
    })),
  };
}

const num = (d: { toString(): string } | null | undefined) => (d == null ? null : Number(d.toString()));

/**
 * The selected products in the exporters' shape, in a DETERMINISTIC order
 * (name, then SKU), whatever order the ids arrived in. Ids that do not
 * belong to this tenant are not found and simply absent — the caller compares
 * counts and refuses a partial export.
 */
export async function loadExportProducts(ids: readonly string[]): Promise<ExportProduct[]> {
  if (ids.length === 0) return [];
  const [products, categories] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: [...new Set(ids)] } },
      orderBy: [{ name: "asc" }, { sku: "asc" }],
      select: {
        id: true,
        name: true,
        sku: true,
        description: true,
        price: true,
        salePrice: true,
        status: true,
        source: true,
        categoryId: true,
        images: { orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { url: true, altText: true } },
        barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
        publications: { select: { provider: true } },
        variations: {
          orderBy: [{ createdAt: "asc" }, { sku: "asc" }],
          select: {
            id: true,
            sku: true,
            attributes: true,
            price: true,
            salePrice: true,
            isActive: true,
            imageUrl: true,
            barcodes: { where: { isPrimary: true }, select: { code: true }, take: 1 },
          },
        },
      },
    }),
    prisma.category.findMany({ select: { id: true, name: true, parentId: true, source: true } }),
  ]);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const pathOf = (id: string | null) => {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let c = id ? byId.get(id) : undefined; c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
      seen.add(c.id);
      path.unshift(c.name);
    }
    return path;
  };

  return products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    description: p.description,
    price: num(p.price),
    salePrice: num(p.salePrice),
    status: p.status,
    source: p.source,
    categoryPath: pathOf(p.categoryId),
    categorySource: p.categoryId ? byId.get(p.categoryId)?.source ?? null : null,
    images: p.images.map((i) => ({ url: i.url, alt: i.altText })),
    barcode: p.barcodes[0]?.code ?? null,
    publishedTo: p.publications.map((x) => (x.provider === "WOOCOMMERCE" ? "woocommerce" : "shopify")),
    variations: p.variations.map((v) => ({
      id: v.id,
      sku: v.sku,
      attributes: Object.fromEntries(
        Object.entries((v.attributes as Record<string, unknown>) ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")
      ),
      price: num(v.price) ?? num(p.price),
      salePrice: num(v.salePrice),
      isActive: v.isActive,
      imageUrl: v.imageUrl,
      barcode: v.barcodes[0]?.code ?? null,
    })),
  }));
}

/** Whether the tenant has a live connection to this store (drives the duplicate-on-sync warning). */
export async function isStoreConnected(platform: ExportPlatform): Promise<boolean> {
  const n = await prisma.integration.count({ where: { provider: PROVIDER[platform], status: "CONNECTE" } });
  return n > 0;
}
