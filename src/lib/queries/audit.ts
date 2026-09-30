import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { auditScopeWhere } from "@/lib/auth/audit-scope";
import { actionsForCategory, type AuditCategory } from "@/lib/audit-labels";
import type { CurrentUser } from "@/lib/auth/session";

export const AUDIT_JOURNAL_PAGE_SIZE = 30;

/**
 * The /journal-audit list (`audit.view`).
 *
 * Phase 4C (docs/adr/0044): an explicit `select` of exactly the columns the
 * journal renders — the event PAYLOADS (`previousValue` / `newValue` /
 * `metadata`) and request details (`ipAddress` / `userAgent`) are never
 * loaded here. Historical payloads may still hold values a viewer isn't
 * entitled to (a product purchase cost recorded before Phase 4C), and
 * `audit.view` does not imply `finance.view`; this list therefore cannot
 * become a path to them. Channel scope (docs/adr/0039) is unchanged.
 */
export async function listAuditJournal(
  viewer: Pick<CurrentUser, "channels">,
  params: { q?: string; category?: AuditCategory; page?: number }
) {
  const page = Math.max(1, params.page ?? 1);
  const conditions: Prisma.AuditEventWhereInput[] = [auditScopeWhere(viewer.channels)];
  if (params.q) {
    conditions.push({
      OR: [
        { action: { contains: params.q, mode: "insensitive" } },
        { entityType: { contains: params.q, mode: "insensitive" } },
      ],
    });
  }
  if (params.category) {
    conditions.push({ action: { in: actionsForCategory(params.category) } });
  }
  const where: Prisma.AuditEventWhereInput = { AND: conditions };

  const [items, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: AUDIT_JOURNAL_PAGE_SIZE,
      skip: (page - 1) * AUDIT_JOURNAL_PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        action: true,
        actorType: true,
        entityType: true,
        entityId: true,
        actorUser: { select: { name: true, email: true } },
      },
    }),
    prisma.auditEvent.count({ where }),
  ]);
  return { items, total, page, pageSize: AUDIT_JOURNAL_PAGE_SIZE };
}
