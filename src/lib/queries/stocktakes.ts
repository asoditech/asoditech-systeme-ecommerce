import "server-only";

import { Prisma, type StocktakeStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const PAGE_SIZE = 25;
const STOCKTAKE_STATUSES: StocktakeStatus[] = ["EN_COURS", "CLOTURE", "ANNULE"];

/** Paginated stocktake list for /inventaires, newest first. */
export async function listStocktakeSessions(params: { status?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const skip = (page - 1) * PAGE_SIZE;
  const where: Prisma.StocktakeSessionWhereInput =
    params.status && (STOCKTAKE_STATUSES as string[]).includes(params.status)
      ? { status: params.status as StocktakeStatus }
      : {};

  const [sessions, total] = await Promise.all([
    prisma.stocktakeSession.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: PAGE_SIZE,
      include: {
        warehouse: { select: { name: true } },
        startedBy: { select: { name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.stocktakeSession.count({ where }),
  ]);

  const countedById = new Map<string, number>();
  if (sessions.length > 0) {
    const grouped = await prisma.stocktakeLine.groupBy({
      by: ["stocktakeSessionId"],
      where: { stocktakeSessionId: { in: sessions.map((s) => s.id) }, countedQuantity: { not: null } },
      _count: { _all: true },
    });
    for (const g of grouped) countedById.set(g.stocktakeSessionId, g._count._all);
  }

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      sessionNumber: s.sessionNumber,
      status: s.status,
      warehouseName: s.warehouse.name,
      startedByName: s.startedBy?.name ?? null,
      totalLines: s._count.lines,
      countedLines: countedById.get(s.id) ?? 0,
      createdAt: s.createdAt,
      closedAt: s.closedAt,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
  };
}

type SessionDetailRow = NonNullable<Awaited<ReturnType<typeof loadStocktakeSession>>>;

function loadStocktakeSession(id: string) {
  return prisma.stocktakeSession.findUnique({
    where: { id },
    include: {
      warehouse: { select: { name: true, type: true, isActive: true } },
      startedBy: { select: { name: true } },
      closedBy: { select: { name: true } },
      lines: {
        orderBy: { id: "asc" },
        include: {
          inventoryItem: {
            select: {
              quantityOnHand: true,
              product: { select: { name: true, sku: true } },
              variation: { select: { sku: true, attributes: true, product: { select: { name: true } } } },
            },
          },
          appliedMovement: { select: { quantity: true, type: true } },
        },
      },
    },
  });
}

function lineView(l: SessionDetailRow["lines"][number]) {
  const iv = l.inventoryItem;
  const label = iv.variation
    ? `${iv.variation.product.name} (${Object.values(iv.variation.attributes as Record<string, string>).join(", ")})`
    : (iv.product?.name ?? "Article supprimé du catalogue");
  const sku = iv.variation?.sku ?? iv.product?.sku ?? "—";
  return {
    id: l.id,
    label,
    sku,
    systemQuantityAtCount: l.systemQuantityAtCount,
    currentQuantity: iv.quantityOnHand,
    countedQuantity: l.countedQuantity,
    variance: l.countedQuantity === null ? null : l.countedQuantity - l.systemQuantityAtCount,
    isStale: l.isStale,
    counted: l.countedQuantity !== null,
    applied: l.appliedAt !== null,
    appliedMovementQuantity: l.appliedMovement?.quantity ?? null,
  };
}

/** Full session for /inventaires/[id]. Returns a narrow DTO — no
 * inventoryItemId / appliedMovementId / countedById leak to the client. */
export async function getStocktakeSessionDetail(id: string) {
  const session = await loadStocktakeSession(id);
  if (!session) return null;

  const lines = session.lines.map(lineView);
  return {
    id: session.id,
    sessionNumber: session.sessionNumber,
    status: session.status,
    notes: session.notes,
    warehouse: session.warehouse,
    startedByName: session.startedBy?.name ?? null,
    closedByName: session.closedBy?.name ?? null,
    createdAt: session.createdAt,
    closedAt: session.closedAt,
    lines,
    summary: {
      total: lines.length,
      counted: lines.filter((l) => l.counted).length,
      stale: lines.filter((l) => l.isStale).length,
      applied: lines.filter((l) => l.applied).length,
    },
  };
}

export async function getStocktakeAuditTimeline(id: string) {
  return prisma.auditEvent.findMany({
    where: { entityType: "StocktakeSession", entityId: id },
    orderBy: { createdAt: "desc" },
    include: { actorUser: { select: { name: true } } },
  });
}
