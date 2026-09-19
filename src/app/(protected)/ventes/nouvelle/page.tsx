import { PageHeader } from "@/components/page-header";
import { SaleForm } from "@/components/sales/sale-form";
import { EmptyState } from "@/components/empty-state";
import { Store } from "lucide-react";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind, listAccessibleChannels } from "@/lib/auth/channel-access";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";
import { userHasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Nouvelle vente — ASODITECH Gestion E-commerce" };

export default async function NouvelleVentePage() {
  const user = await requirePermission("sales.create");
  requireChannelKind(user, "OFFLINE");

  // Only the store channels this user is assigned to, and — per channel — only
  // the mapped locations they are ALSO assigned to (ADR 0037 + 0039).
  const [channels, accessible, mappings] = await Promise.all([
    listAccessibleChannels(user, "OFFLINE"),
    listAccessibleActiveWarehouses(user),
    prisma.salesChannelLocation.findMany({ select: { salesChannelId: true, warehouseId: true } }),
  ]);
  const okWarehouse = new Map(accessible.map((w) => [w.id, w]));
  const locationsByChannel: Record<string, { id: string; name: string }[]> = {};
  for (const c of channels) {
    locationsByChannel[c.id] = mappings
      .filter((m) => m.salesChannelId === c.id && okWarehouse.has(m.warehouseId))
      .map((m) => ({ id: m.warehouseId, name: okWarehouse.get(m.warehouseId)!.name }));
  }
  const usable = channels.filter((c) => (locationsByChannel[c.id] ?? []).length > 0);

  return (
    <div>
      <PageHeader title="Nouvelle vente" breadcrumbs={[{ label: "Ventes magasin", href: "/ventes" }, { label: "Nouvelle" }]} />
      {usable.length === 0 ? (
        <EmptyState
          icon={Store}
          title="Aucun point de vente utilisable."
          description="Il faut un canal magasin, rattaché à un emplacement auquel vous avez accès. Demandez à un administrateur (Paramètres → Canaux de vente)."
        />
      ) : (
        <SaleForm
          channels={usable.map((c) => ({ id: c.id, name: c.name }))}
          locationsByChannel={locationsByChannel}
          canOverridePrice={userHasPermission(user, "sales.override_price")}
        />
      )}
    </div>
  );
}
