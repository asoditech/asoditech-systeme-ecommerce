import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Channel reads — docs/adr/0038. Read scoping by the acting user's channel
 * access is layered on top in src/lib/auth/channel-access.ts (docs/adr/0039);
 * these are the raw, tenant-scoped listings.
 */

export async function listActiveChannels() {
  return prisma.salesChannel.findMany({
    where: { isActive: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    select: { id: true, name: true, kind: true, isDefault: true },
  });
}

export async function listChannelsWithLocations() {
  return prisma.salesChannel.findMany({
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    include: {
      locations: { include: { warehouse: { select: { id: true, name: true, type: true, isActive: true } } } },
      _count: { select: { products: true, users: true } },
    },
  });
}
