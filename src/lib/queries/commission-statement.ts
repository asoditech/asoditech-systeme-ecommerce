import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Everything one printable commission statement ("relevé / facture agent")
 * needs: the frozen statement, its agent + linked user, and the
 * individual EARNED/REVERSED entries swept into it, each with its order's
 * display number. Tenant-scoped through `prisma`. `null` when the
 * statement does not exist (or belongs to another tenant / another agent).
 */
export async function getCommissionStatementForPrint(agentId: string, statementId: string) {
  const statement = await prisma.commissionStatement.findFirst({
    where: { id: statementId, agentId },
    include: {
      agent: { include: { user: { select: { name: true, email: true } } } },
      entries: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          amount: true,
          createdAt: true,
          order: {
            select: {
              orderNumber: true,
              displayNumber: true,
              source: true,
              externalNumber: true,
              placedAt: true,
              customer: { select: { fullName: true } },
            },
          },
        },
      },
    },
  });
  return statement;
}
