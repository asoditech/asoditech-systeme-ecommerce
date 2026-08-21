import "server-only";

import { prisma } from "@/lib/prisma";
import type { Prisma, ProductStatus } from "@prisma/client";

const PAGE_SIZE = 20;

export async function listProducts(params: { q?: string; categoryId?: string; status?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ProductWhereInput = {
    ...(params.q
      ? {
          OR: [
            { name: { contains: params.q, mode: "insensitive" } },
            { sku: { contains: params.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(params.categoryId ? { categoryId: params.categoryId } : {}),
    ...(params.status ? { status: params.status as ProductStatus } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        category: true,
        inventoryItems: { select: { quantityOnHand: true, quantityReserved: true } },
        variations: { select: { id: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  return { products, total, page, pageSize: PAGE_SIZE };
}

export async function getProductDetail(id: string) {
  return prisma.product.findUnique({
    where: { id },
    include: {
      category: true,
      images: { orderBy: { position: "asc" } },
      variations: { include: { inventoryItems: true }, orderBy: { createdAt: "asc" } },
      inventoryItems: { include: { warehouse: true } },
    },
  });
}

export async function listCategories() {
  return prisma.category.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } });
}

export async function getProductSalesStats(productId: string) {
  const stats = await prisma.orderItem.aggregate({
    where: { productId, order: { status: { notIn: ["ANNULEE", "ECHEC"] } } },
    _sum: { quantity: true, total: true },
  });
  return {
    unitsSold: stats._sum.quantity ?? 0,
    revenue: stats._sum.total ?? null,
  };
}
