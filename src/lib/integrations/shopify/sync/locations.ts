import "server-only";

import { prisma } from "@/lib/prisma";
import type { ShopifyClient } from "../client";
import { emptySyncSummary, recordNote, type SyncSummary } from "@/lib/integrations/shared";

/**
 * Shopify → System, one direction (see docs/adr/0011-shopify-integration.md).
 * Each active Shopify Location becomes its own Warehouse row (matched by
 * source=SHOPIFY, externalId=<location gid>) — unlike WooCommerce (no
 * location concept, always the single default warehouse), Shopify tracks
 * inventory per-location, so this is what lets that be represented
 * faithfully rather than collapsed into one number.
 *
 * `isDefault` is never set true here — the system's own default warehouse
 * (used by manually-created orders and other providers) is never touched
 * by this sync. Inactive locations are skipped, not imported — a
 * deliberately conservative choice; a location that later goes inactive
 * again is left alone rather than deleted (no destructive action here).
 *
 * Returns the summary plus a Shopify location gid → internal Warehouse id
 * map, for product/stock sync to resolve which Warehouse a location's
 * inventory belongs to.
 */
export async function syncLocations(client: ShopifyClient): Promise<{ summary: SyncSummary; idMap: Map<string, string> }> {
  const summary = emptySyncSummary();
  const idMap = new Map<string, string>();

  for await (const page of client.listAllLocations()) {
    for (const location of page) {
      if (!location.isActive) {
        summary.skipped++;
        continue;
      }
      try {
        const existing = await prisma.warehouse.findFirst({ where: { source: "SHOPIFY", externalId: location.id } });
        if (existing) {
          if (existing.name !== location.name) {
            await prisma.warehouse.update({ where: { id: existing.id }, data: { name: location.name } });
            summary.updated++;
          } else {
            summary.unchanged++;
          }
          idMap.set(location.id, existing.id);
          continue;
        }

        const created = await prisma.warehouse.create({
          data: { name: location.name, source: "SHOPIFY", externalId: location.id, isDefault: false },
        });
        idMap.set(location.id, created.id);
        summary.imported++;
      } catch {
        recordNote(summary, `Emplacement Shopify ${location.name} : échec de synchronisation.`);
        summary.failed++;
      }
    }
  }

  return { summary, idMap };
}
