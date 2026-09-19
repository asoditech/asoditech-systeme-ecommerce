import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { ChannelsPanel } from "@/components/settings/channels-panel";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listChannelsWithLocations } from "@/lib/queries/channels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Canaux de vente — ASODITECH Gestion E-commerce" };

/**
 * Business channels (docs/adr/0038): where the business sells (Online store,
 * physical stores) and which physical locations each one sells from.
 * `channels.manage` (OWNER/ADMIN) — an org-structure decision.
 */
export default async function CanauxPage() {
  const user = await requirePermission("channels.manage");
  const [channels, locations] = await Promise.all([
    listChannelsWithLocations(),
    prisma.warehouse.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);

  return (
    <div>
      <PageHeader title="Paramètres" description="Canaux de vente : où l'activité se déroule, et depuis quels emplacements." />
      <div className="max-w-3xl">
        <SettingsNav canManage={userHasPermission(user, "settings.manage")} canManageChannels />
        <ChannelsPanel
          channels={channels.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            isActive: c.isActive,
            isDefault: c.isDefault,
            warehouseIds: c.locations.filter((l) => l.warehouse.isActive).map((l) => l.warehouseId),
            productCount: c._count.products,
            userCount: c._count.users,
          }))}
          locations={locations}
        />
      </div>
    </div>
  );
}
