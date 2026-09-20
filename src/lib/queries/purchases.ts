import "server-only";

import { Prisma, type ReceptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSupplierBalance } from "@/lib/receptions";

/** Suppliers & receptions reads — docs/adr/0040. Permission-gated by the pages (`suppliers.view` / `purchases.view`). */

const PAGE_SIZE = 20;
const zero = () => new Prisma.Decimal(0);

export async function listSuppliers(params: { q?: string; page?: number } = {}) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.SupplierWhereInput = params.q
    ? { OR: [{ name: { contains: params.q, mode: "insensitive" } }, { phone: { contains: params.q } }] }
    : {};
  const [suppliers, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: { name: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.supplier.count({ where }),
  ]);
  const ids = suppliers.map((s) => s.id);
  // Balances DERIVED in two grouped queries — never a query per row.
  const [received, paid] = await Promise.all([
    prisma.reception.groupBy({ by: ["supplierId"], where: { supplierId: { in: ids }, status: "VALIDEE" }, _sum: { totalCost: true } }),
    prisma.supplierPayment.groupBy({ by: ["supplierId"], where: { supplierId: { in: ids } }, _sum: { amount: true } }),
  ]);
  const rows = suppliers.map((s) => {
    const r = received.find((x) => x.supplierId === s.id)?._sum.totalCost ?? zero();
    const p = paid.find((x) => x.supplierId === s.id)?._sum.amount ?? zero();
    return { ...s, totalReceived: r, totalPaid: p, balance: r.minus(p) };
  });
  return { suppliers: rows, total, page, pageSize: PAGE_SIZE };
}

export async function getSupplierDetail(id: string) {
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) return null;
  const [receptions, payments, balance] = await Promise.all([
    prisma.reception.findMany({
      where: { supplierId: id },
      orderBy: { receptionDate: "desc" },
      take: 50,
      include: { payments: { select: { amount: true } }, warehouse: { select: { name: true } } },
    }),
    prisma.supplierPayment.findMany({ where: { supplierId: id }, orderBy: { paidAt: "desc" }, take: 50 }),
    getSupplierBalance(id),
  ]);
  return {
    supplier,
    balance,
    payments,
    receptions: receptions.map((r) => ({
      ...r,
      paid: r.payments.reduce((s, p) => s.plus(p.amount), zero()),
    })),
  };
}

export async function listReceptions(params: { status?: ReceptionStatus; supplierId?: string; page?: number } = {}) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ReceptionWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.supplierId ? { supplierId: params.supplierId } : {}),
  };
  const [receptions, total] = await Promise.all([
    prisma.reception.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { supplier: { select: { name: true } }, warehouse: { select: { name: true } }, _count: { select: { lines: true } } },
    }),
    prisma.reception.count({ where }),
  ]);
  return { receptions, total, page, pageSize: PAGE_SIZE };
}

export async function getReceptionDetail(id: string) {
  return prisma.reception.findUnique({
    where: { id },
    include: {
      supplier: true,
      warehouse: { select: { id: true, name: true } },
      lines: { orderBy: { createdAt: "asc" }, include: { variation: { select: { attributes: true } } } }, // variation: only to label a variant line
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
}
