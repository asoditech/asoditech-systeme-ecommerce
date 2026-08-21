import "server-only";

import { prisma } from "@/lib/prisma";
import type { WooCommerceClient } from "../client";
import type { WcProductCategory } from "../types";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";

/**
 * WooCommerce → System, one direction only (see docs/adr/0010). Categories
 * are matched by (source=WOOCOMMERCE, externalId). If a slug collision
 * occurs against an unrelated internal (or differently-sourced) category,
 * this never silently adopts/overwrites that category — it suffixes the
 * incoming slug instead, so ownership of a manually-created category is
 * never hijacked by a sync run.
 *
 * Returns the summary plus a WooCommerce category id → internal Category
 * id map, for product sync to resolve `categoryId` with.
 */
export async function syncCategories(
  client: WooCommerceClient
): Promise<{ summary: SyncSummary; idMap: Map<number, string> }> {
  const summary = emptySyncSummary();
  const idMap = new Map<number, string>();
  const all: WcProductCategory[] = [];

  for await (const page of client.listAllProductCategories()) {
    all.push(...page);
  }

  // Pass 1: create/update every category without setting parentId yet — a
  // child can appear before its parent in the paginated list.
  for (const wc of all) {
    try {
      const existing = await prisma.category.findFirst({
        where: { source: "WOOCOMMERCE", externalId: String(wc.id) },
      });

      if (existing) {
        const changed = existing.name !== wc.name || existing.slug !== wc.slug || existing.description !== (wc.description?.trim() || null);
        if (changed) {
          const updated = await prisma.category.update({
            where: { id: existing.id },
            data: { name: wc.name, slug: existing.slug, description: wc.description?.trim() || null },
          });
          idMap.set(wc.id, updated.id);
          summary.updated++;
        } else {
          idMap.set(wc.id, existing.id);
          summary.unchanged++;
        }
        continue;
      }

      const slugTaken = await prisma.category.findUnique({ where: { slug: wc.slug } });
      const slug = slugTaken ? `${wc.slug}-wc-${wc.id}` : wc.slug;

      const created = await prisma.category.create({
        data: {
          name: wc.name,
          slug,
          description: wc.description?.trim() || null,
          source: "WOOCOMMERCE",
          externalId: String(wc.id),
        },
      });
      idMap.set(wc.id, created.id);
      summary.imported++;
    } catch {
      recordNote(summary, `Catégorie WooCommerce #${wc.id} : échec de synchronisation.`);
      summary.failed++;
    }
  }

  // Pass 2: link parents now that every category in this run has an internal id.
  for (const wc of all) {
    if (!wc.parent) continue;
    const internalId = idMap.get(wc.id);
    const parentInternalId = idMap.get(wc.parent);
    if (!internalId || !parentInternalId || internalId === parentInternalId) continue;
    await prisma.category.update({ where: { id: internalId }, data: { parentId: parentInternalId } }).catch(() => {
      recordNote(summary, `Catégorie WooCommerce #${wc.id} : échec du rattachement à sa catégorie parente.`);
    });
  }

  return { summary, idMap };
}
