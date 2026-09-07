import "server-only";

import { prisma } from "@/lib/prisma";

/** Pending invitations for the /utilisateurs page — auto-scoped to the
 * caller's own tenant like every other query in this file. */
export async function listPendingInvitations() {
  return prisma.invitation.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    include: { invitedBy: { select: { name: true } } },
  });
}
