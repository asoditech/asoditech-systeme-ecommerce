import "server-only";
import { enableProductOnDefaultOnlineChannel } from "@/lib/channels";

import { prisma } from "@/lib/prisma";
import { patchIntegrationConfig } from "@/lib/integrations/shared/integration-config";
import { deactivateRemovedVariations } from "@/lib/integrations/shared/variations";
import type { WooCommerceClient } from "../client";
import { mapProductFields } from "../mapper";
import type { WcProduct, WcProductVariation } from "../types";
import { emptySyncSummary, recordNote, type SyncSummary } from "./types";
import { reconcileStockFromWooCommerce } from "./stock";
import type { SyncActor } from "./actor";
import { syncProductLeadImage } from "@/lib/integrations/shared";
import { resolveStoreProduct, resolveStoreVariation } from "@/lib/integrations/shared/identity";
import { inventoryOwnerOf, type InventoryOwner } from "../store-settings";

/**
 * WooCommerce → System, one direction (see docs/adr/0010-woocommerce-integration.md).
 * Products are matched by (source=WOOCOMMERCE, externalId). Field
 * ownership: name/sku/description/price/salePrice/status/categoryId are
 * WooCommerce-owned and overwritten every sync; `cost` and
 * `lowStockThreshold` are internal-only and never touched here, even on an
 * update. `trackInventory` follows the company's « Qui gère le stock ? »
 * (store-settings.ts): ASODITECH (default) → the store's flag only seeds a
 * NEW product, an existing product keeps the user's own choice
 * (updateProductOperationalSettingsAction); the store → overwritten every
 * sync, as before. A product with no matching internal Category (or no category at
 * all) is imported with `categoryId: null` — this is not an error.
 *
 * WooCommerce lets a product belong to several categories; the internal
 * schema has a single `categoryId` FK, so only the first WooCommerce
 * category (if any) is used — a deliberate, documented simplification, not
 * a silent data loss (the rest are simply not representable in this phase).
 *
 * Resumable and capped per run, for the same reason as `syncOrders` (see
 * its own doc comment): Vercel Hobby's tight wall-clock budget can't
 * guarantee a full catalog pass finishes in one call, and a variable
 * product costs an *extra* paginated request for its variations on top of
 * the product itself. Without a persisted resume point, a run that times
 * out mid-catalog restarted from page 1 every single time — so a product
 * sitting past wherever the scan always dies (a newly added one is
 * usually on the last page) could never be reached no matter how many
 * times "Synchroniser les produits" was clicked.
 *
 * Unlike `syncOrders`, an "already synced" product can't be skipped for
 * free on a resumed run: its stock still needs re-checking every single
 * pass (that's the whole point of the pull half of the stock sync — see
 * `reconcileStockFromWooCommerce` below), even when its name/price/etc.
 * haven't changed. So resuming at just "the same page number" would
 * reprocess that page's already-handled leading items until the cap,
 * making no forward progress ever on a page bigger than the cap. Instead,
 * `Integration.config.productsResumePage`/`productsResumeOffset` track
 * both the page AND the index within it this run stopped at, so the next
 * run picks up genuinely new/unchecked items on a re-fetch of that same
 * page instead of starting over from its first item.
 */
const MAX_PRODUCTS_PER_RUN = 20;

export async function syncProducts(
  client: WooCommerceClient,
  categoryIdMap: Map<number, string>,
  actor: SyncActor,
  integrationId: string
): Promise<SyncSummary> {
  const summary = emptySyncSummary();
  const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
  if (!warehouse) {
    // Without a default warehouse every `reconcileStockFromWooCommerce`
    // call below is skipped and stock silently never lands — surface that
    // instead of reporting a clean success. `provisionTenantBaseline`
    // creates this row for new tenants; `scripts/backfill-tenant-baseline.ts`
    // repairs older ones.
    recordNote(
      summary,
      "Aucun entrepôt par défaut configuré — les produits sont importés mais le stock ne peut pas être synchronisé. Contactez le support."
    );
  }

  const integration = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
  const config = (integration.config as Record<string, unknown> | null) ?? {};
  // « Qui gère le stock des produits importés ? » (store-settings.ts) — ASODITECH unless explicitly set to the store.
  const inventoryOwner = inventoryOwnerOf(config);
  const startPage =
    typeof config.productsResumePage === "number" && config.productsResumePage > 0
      ? Math.floor(config.productsResumePage)
      : 1;
  const startOffset =
    typeof config.productsResumeOffset === "number" && config.productsResumeOffset > 0
      ? Math.floor(config.productsResumeOffset)
      : 0;

  let processedThisRun = 0;
  let capped = false;
  let resumePage = 1;
  let resumeOffset = 0;
  let isFirstPageThisRun = true;

  for await (const { items: pageItems, page, totalPages } of client.listAllProducts(startPage)) {
    // The resume offset only applies to the very first page fetched this
    // run (wherever the previous run's cap actually stopped) — any later
    // page within the same run is fetched fresh and starts at its own 0.
    const applyOffset = isFirstPageThisRun && startOffset > 0;
    const items = applyOffset ? pageItems.slice(startOffset) : pageItems;
    let indexInPage = applyOffset ? startOffset : 0;
    isFirstPageThisRun = false;

    resumePage = page >= totalPages ? 1 : page + 1;
    resumeOffset = 0;

    for (const wc of items) {
      if (processedThisRun >= MAX_PRODUCTS_PER_RUN) {
        capped = true;
        resumePage = page;
        resumeOffset = indexInPage;
        break;
      }
      try {
        // Deliberate, operator-triggered sync — stock reconciliation is
        // the whole point of the pull half (see this function's own doc
        // comment): reconcile every pass.
        await syncOneProduct(client, wc, categoryIdMap, warehouse?.id ?? null, actor, summary, true, false, inventoryOwner);
      } catch {
        recordNote(summary, `Produit WooCommerce #${wc.id} (${wc.sku || wc.name}) : échec de synchronisation.`);
        summary.failed++;
      }
      processedThisRun++;
      indexInPage++;
    }
    if (capped) break;
  }

  await patchIntegrationConfig(integrationId, { productsResumePage: resumePage, productsResumeOffset: resumeOffset });

  summary.hasMore = capped;
  if (capped) {
    recordNote(
      summary,
      `Lot traité (max ${MAX_PRODUCTS_PER_RUN} produits) — relancez « Synchroniser les produits » pour continuer.`
    );
  }

  return summary;
}

async function syncOneProduct(
  client: WooCommerceClient,
  wc: WcProduct,
  categoryIdMap: Map<number, string> | null,
  warehouseId: string | null,
  actor: SyncActor,
  summary: SyncSummary,
  /**
   * `true` only for the deliberate, operator-triggered bulk sync
   * (`syncProducts`) — never for the `product.updated`/`product.created`
   * webhook path (`importProduct`). WooCommerce decrements its OWN
   * `stock_quantity` the instant an order is placed on a "Manage stock"
   * product, completely independent of ASODITECH's order/confirmation
   * status — that decrement fires this exact webhook. Reconciling stock
   * from it would silently write WooCommerce's pre-confirmation number
   * into `quantityOnHand`, corrupting ASODITECH's own reservation-based
   * physical stock for an order nobody has confirmed yet (2026-09-13
   * incident — see docs/adr/0030's addendum). Real-time webhook handling
   * of name/price/status/category is still fully live either way — only
   * the stock-quantity pull is skipped.
   */
  reconcileStock: boolean,
  /**
   * Archive is sticky (2026-10-12): a product that is ARCHIVE in ASODITECH —
   * archived by hand, or because the store deleted it — is never moved back
   * to ACTIF/BROUILLON by a sync or a product.updated webhook (before, the
   * store's status silently undid a manual archive on the next sync). Only
   * the store's explicit `product.restored` webhook passes `true` here; a
   * user can also re-activate the product in ASODITECH at any time. Every
   * other field (name, price, category, variations…) keeps syncing, and the
   * row keeps its store id — a re-sync matches it and never duplicates it.
   */
  restoreArchived = false,
  /**
   * Who manages the stock of imported products (store-settings.ts). `ASODITECH`
   * (default, docs/adr/0036): a unit the store manages that ASODITECH has no
   * row for gets one at the store's reported quantity — none when the store
   * reports none (never an invented 0); an existing row is never touched; an
   * existing product's `trackInventory` is the user's, never the store's.
   * `STORE`: the import creates no stock row at all, and ASODITECH never
   * pushes stock to the store (stock-push.ts); rows that already exist stay.
   */
  inventoryOwner: InventoryOwner = "ASODITECH"
): Promise<void> {
  // A `product_variation` is NOT a catalogue product — it must only ever
  // become a `ProductVariation` row under its parent. WooCommerce's
  // `product.updated` webhook fires for variation saves too, and a
  // variation's REST body carries just enough (`name`, `slug:""`,
  // `status`) to slip past `wcProductSchema`. The webhook route already
  // redirects those to the parent, but this guard is the backstop so a
  // variation can never land as a standalone product no matter how
  // `syncOneProduct` is reached. See docs/adr/0010 addendum.
  if (wc.type === "variation") return;

  const fields = mapProductFields(wc);
  // The bulk sync passes a pre-built map (one query for the whole
  // catalog); a single-item webhook import has no map worth building for
  // one product, so it resolves the one category it needs directly.
  let categoryId = wc.categories[0]
    ? categoryIdMap
      ? (categoryIdMap.get(wc.categories[0].id) ?? null)
      : ((await prisma.category.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(wc.categories[0].id) } }))?.id ?? null)
    : null;
  const externalId = String(wc.id);

  // Identity (docs/adr/0055): already linked → publication → same SKU (an
  // ASODITECH product exported/published to this store) → else new.
  const resolved = await resolveStoreProduct("WOOCOMMERCE", externalId, { sku: wc.sku, isVariable: wc.type === "variable" });
  const existing = resolved?.product ?? null;
  if (resolved && resolved.via !== "linked") {
    recordNote(
      summary,
      `Produit WooCommerce #${wc.id} rattaché au produit ASODITECH existant « ${resolved.product.name} » (${resolved.via === "sku" ? "même SKU" : "publication"}) — aucun doublon créé.`
    );
    // Keep the ASODITECH category while the store's own category is unknown locally.
    if (categoryId === null) categoryId = resolved.product.categoryId;
  }

  let productId: string;
  let localTracked = fields.trackInventory;
  if (existing) {
    // Backfill / correct platformCreatedAt whenever WooCommerce gives us a
    // date the row doesn't already carry (rows imported before this field
    // existed have it set to their local createdAt by the migration).
    const needsPlatformDate =
      fields.platformCreatedAt !== null &&
      existing.platformCreatedAt?.getTime() !== fields.platformCreatedAt.getTime();

    const status = existing.status === "ARCHIVE" && !restoreArchived ? "ARCHIVE" : fields.status;
    // ASODITECH manages the stock: whether this product is tracked is the
    // user's decision, never switched on or off by the store's own flag.
    const trackInventory = inventoryOwner === "ASODITECH" ? existing.trackInventory : fields.trackInventory;
    localTracked = trackInventory;
    const changed =
      existing.name !== fields.name ||
      existing.description !== fields.description ||
      Number(existing.price) !== fields.price ||
      (existing.salePrice ? Number(existing.salePrice) : null) !== fields.salePrice ||
      existing.status !== status ||
      existing.trackInventory !== trackInventory ||
      existing.categoryId !== categoryId ||
      needsPlatformDate;

    if (changed) {
      // A SKU collision against a *different* internal product (e.g. the
      // WooCommerce SKU was reused/renamed on the store side) must not
      // silently steal that other product's SKU — skip this field rather
      // than fail the whole item.
      const skuOwner = await prisma.product.findFirst({ where: { sku: fields.sku } });
      const sku = !skuOwner || skuOwner.id === existing.id ? fields.sku : existing.sku;

      await prisma.product.update({
        where: { id: existing.id },
        data: {
          name: fields.name,
          sku,
          description: fields.description,
          price: fields.price,
          salePrice: fields.salePrice,
          status,
          trackInventory,
          categoryId,
          ...(fields.platformCreatedAt ? { platformCreatedAt: fields.platformCreatedAt } : {}),
        },
      });
      summary.updated++;
    } else {
      summary.unchanged++;
    }
    productId = existing.id;
    // Manual review (never acted on here): the next stock push would switch on
    // the store's stock management for a product it no longer manages.
    if (inventoryOwner === "ASODITECH" && reconcileStock && trackInventory && !fields.trackInventory && wc.type !== "variable") {
      recordNote(
        summary,
        `Produit « ${existing.name} » : stock suivi dans ASODITECH mais pas par la boutique — le prochain envoi de stock y activera la gestion du stock. Désactivez « Suivre le stock » sur la fiche produit si ce n'est pas voulu.`
      );
    }
  } else {
    const skuOwner = await prisma.product.findFirst({ where: { sku: fields.sku } });
    const sku = skuOwner ? `${fields.sku}-wc-${wc.id}` : fields.sku;

    const created = await prisma.product.create({
      data: {
        name: fields.name,
        sku,
        description: fields.description,
        price: fields.price,
        salePrice: fields.salePrice,
        status: fields.status,
        trackInventory: fields.trackInventory,
        categoryId,
        source: "WOOCOMMERCE",
        externalId,
        platformCreatedAt: fields.platformCreatedAt,
      },
    });
    productId = created.id;
    // docs/adr/0038: a synced product is sellable on the default ONLINE channel.
    await enableProductOnDefaultOnlineChannel(created.id);
    summary.imported++;
    if (inventoryOwner === "ASODITECH" && !fields.trackInventory && wc.type !== "variable") {
      recordNote(
        summary,
        `Produit « ${fields.name} » importé sans suivi de stock (la boutique ne le suit pas) — activez « Suivre le stock » sur la fiche produit si ASODITECH doit gérer son stock.`
      );
    }
  }

  await syncProductLeadImage(productId, wc.images[0]?.src ?? null, wc.images[0]?.alt ?? null);

  // A row is only ever onboarded from a quantity the store actually reports
  // for a unit it manages — a missing quantity is never turned into 0 (a 0 row
  // would be pushed back as « épuisé »): no row, flagged for manual review.
  if (inventoryOwner === "ASODITECH" && reconcileStock && fields.trackInventory && warehouseId) {
    if (wc.stock_quantity != null) {
      await reconcileStockFromWooCommerce({
        productId,
        warehouseId,
        externalQuantity: wc.stock_quantity,
        actor,
      });
    } else if (wc.type !== "variable" && !(await prisma.inventoryItem.findFirst({ where: { productId, warehouseId }, select: { id: true } }))) {
      recordNote(
        summary,
        `Produit « ${fields.name} » : la boutique suit son stock sans indiquer de quantité — aucun stock créé ni envoyé. Enregistrez une réception d'achat dans ASODITECH, ou indiquez sa quantité sur la boutique puis relancez la synchronisation.`
      );
    }
  }

  if (wc.type === "variable" && wc.variations.length > 0) {
    const stock = await syncVariationsForProduct(client, wc.id, productId, warehouseId, actor, summary, reconcileStock, wc.variations.map(String), inventoryOwner);
    if (inventoryOwner === "ASODITECH" && reconcileStock) {
      if (!localTracked && stock.managed > 0) {
        recordNote(
          summary,
          `Produit variable « ${fields.name} » : la boutique gère le stock de ${stock.managed} variante(s), mais le suivi du stock est désactivé dans ASODITECH — rien n'est envoyé. Activez « Suivre le stock » sur la fiche produit si ASODITECH doit le gérer.`
        );
      }
      if (stock.noOwnQuantity > 0) {
        recordNote(
          summary,
          `Produit variable « ${fields.name} » : ${stock.noOwnQuantity} variante(s) sans quantité propre sur la boutique (stock du parent ou quantité absente) — aucun stock créé ni envoyé pour elles. Enregistrez une réception d'achat dans ASODITECH, ou gérez leur stock par variante sur la boutique puis relancez la synchronisation.`
        );
      }
    }
  }
}

async function syncVariationsForProduct(
  client: WooCommerceClient,
  wcProductId: number,
  productId: string,
  warehouseId: string | null,
  actor: SyncActor,
  summary: SyncSummary,
  reconcileStock: boolean,
  /** The parent's own current `variations` id list (second source of truth for « gone »). */
  parentVariationIds: readonly string[] = [],
  inventoryOwner: InventoryOwner = "ASODITECH"
): Promise<{ managed: number; noOwnQuantity: number }> {
  const variationExternalIds: string[] = [];
  const stock = { managed: 0, noOwnQuantity: 0 };
  for await (const page of client.listAllProductVariations(wcProductId)) {
    for (const wcVar of page) {
      variationExternalIds.push(String(wcVar.id));
      if (wcVar.manage_stock === true) stock.managed++;
      try {
        const { outcome, missingQuantity } = await syncOneVariation(wcVar, productId, warehouseId, actor, reconcileStock, inventoryOwner);
        summary[outcome]++;
        if (missingQuantity) stock.noOwnQuantity++;
      } catch {
        recordNote(summary, `Variation WooCommerce #${wcVar.id} : échec de synchronisation.`);
        summary.failed++;
      }
    }
  }

  // Self-heal: a past `product.updated` webhook for a variation save may
  // have created a bogus standalone Product row keyed by the variation's
  // own id (the pre-fix behaviour — see docs/adr/0010 addendum). Now that
  // the variation is correctly attached to its parent, drop that
  // duplicate — but only when it carries no order history (OrderItem is
  // onDelete:SetNull, so a sale keeps its snapshot regardless, but we
  // still don't want to silently detach one).
  await cleanupBogusVariationProducts(variationExternalIds, productId, summary);

  // Reached only after EVERY variation page was fetched (a fetch error
  // throws above): a variation deleted in the store is deactivated here —
  // never deleted (orders, stock movements and returns keep pointing at
  // it) and never reactivated automatically. « Gone » = absent from the
  // fetched list AND from the parent's own list; an empty fetch is never
  // trusted to deactivate anything.
  if (variationExternalIds.length > 0) {
    await deactivateRemovedVariations(productId, "WOOCOMMERCE", [...variationExternalIds, ...parentVariationIds], summary);
  }
  return stock;
}


/**
 * Deletes standalone `Product` rows (source WOOCOMMERCE) whose `externalId`
 * is actually one of `variationExternalIds` — i.e. rows that a
 * variation-save webhook wrongly created before the parent-redirect fix.
 * A row with sold lines is left in place and reported instead.
 */
async function cleanupBogusVariationProducts(
  variationExternalIds: string[],
  realParentProductId: string,
  summary: SyncSummary
): Promise<void> {
  if (variationExternalIds.length === 0) return;
  const bogus = await prisma.product.findMany({
    where: {
      source: "WOOCOMMERCE",
      externalId: { in: variationExternalIds },
      id: { not: realParentProductId },
    },
    select: { id: true, name: true, _count: { select: { orderItems: true, variations: true } } },
  });
  for (const p of bogus) {
    // A genuine parent product would have its own variations; a bogus
    // variation-row never does. Guard against an id coincidence.
    if (p._count.variations > 0) continue;
    if (p._count.orderItems > 0) {
      recordNote(
        summary,
        `Produit en double « ${p.name} » (créé à tort depuis une variante) — conservé car il a un historique de commandes. À fusionner manuellement.`
      );
      continue;
    }
    // A bogus row that somehow acquired stock history must not take its
    // ledger with it (docs/adr/0038) — keep it and flag it, like an order.
    const movements = await prisma.inventoryMovement.count({ where: { inventoryItem: { productId: p.id } } });
    if (movements > 0) {
      recordNote(
        summary,
        `Produit en double « ${p.name} » (créé à tort depuis une variante) — conservé car il a un historique de stock. À fusionner manuellement.`
      );
      continue;
    }
    await prisma.product.delete({ where: { id: p.id } });
    recordNote(summary, `Produit en double « ${p.name} » (issu d'une variante) supprimé.`);
  }
}

async function syncOneVariation(
  wc: WcProductVariation,
  productId: string,
  warehouseId: string | null,
  actor: SyncActor,
  reconcileStock: boolean,
  inventoryOwner: InventoryOwner = "ASODITECH"
): Promise<{ outcome: "imported" | "updated" | "unchanged"; missingQuantity: boolean }> {
  const externalId = String(wc.id);
  const sku = wc.sku.trim() || `WC-VAR-${wc.id}`;
  const price = wc.regular_price || wc.price || null;
  const attributes = Object.fromEntries(wc.attributes.map((a) => [a.name, a.option]));

  // Within this parent only: linked, else the parent's own unlinked variation with the same SKU (docs/adr/0055).
  const existing = await resolveStoreVariation("WOOCOMMERCE", externalId, productId, wc.sku);

  let variationId: string;
  let outcome: "imported" | "updated" | "unchanged" = "imported";
  if (existing) {
    const attrsChanged = JSON.stringify(existing.attributes) !== JSON.stringify(attributes);
    const priceChanged = price != null && Number(existing.price ?? 0) !== price;
    if (attrsChanged || priceChanged) {
      await prisma.productVariation.update({
        where: { id: existing.id },
        data: { attributes, price: price ?? existing.price },
      });
      outcome = "updated";
    } else {
      outcome = "unchanged";
    }
    variationId = existing.id;
  } else {
    const skuOwner = await prisma.productVariation.findFirst({ where: { sku } });
    const finalSku = skuOwner ? `${sku}-wc-${wc.id}` : sku;
    const created = await prisma.productVariation.create({
      data: {
        productId,
        sku: finalSku,
        attributes,
        price,
        source: "WOOCOMMERCE",
        externalId,
      },
    });
    variationId = created.id;
  }

  // Same rule as the product (syncOneProduct): a row is onboarded only from
  // THIS variation's own reported quantity — never the parent's (`"parent"`),
  // never 0 for a missing one. Those stay without a row: nothing to push.
  let missingQuantity = false;
  if (inventoryOwner === "ASODITECH" && reconcileStock && warehouseId) {
    if (wc.manage_stock === true && wc.stock_quantity != null) {
      await reconcileStockFromWooCommerce({
        variationId,
        warehouseId,
        externalQuantity: wc.stock_quantity,
        actor,
      });
    } else if (wc.manage_stock !== false) {
      missingQuantity = !(await prisma.inventoryItem.findFirst({ where: { variationId, warehouseId }, select: { id: true } }));
    }
  }

  return { outcome, missingQuantity };
}

/**
 * Single-product counterpart to `syncProducts`, for the product.created/
 * product.updated webhook path (see docs/adr/0010-woocommerce-integration.md
 * addendum): imports/updates exactly one product (and its variations, if
 * any) — the same `syncOneProduct` the bulk sync uses, just without a
 * pre-built category map (see its own doc comment) and resolving the
 * default warehouse itself. Real-time product sync layered on top of the
 * resumable bulk sync as a safety net for a missed or never-configured
 * webhook, not a replacement for it.
 *
 * Deliberately does NOT reconcile stock (2026-09-13 fix — see
 * `syncOneProduct`'s `reconcileStock` param doc comment): this webhook
 * fires every time WooCommerce's own "Manage stock" auto-decrements on an
 * order placement, which happens before ASODITECH has confirmed anything
 * — pulling that number here would silently corrupt `quantityOnHand` for
 * an order nobody has reviewed yet. Name/price/status/category still
 * sync in real time either way. Stock reconciliation remains fully
 * available via the explicit "Synchroniser les produits" bulk action
 * (`syncProducts`), which a human deliberately triggers.
 */
export async function importProduct(
  client: WooCommerceClient,
  wc: WcProduct,
  actor: SyncActor,
  options: { restoreArchived?: boolean } = {}
): Promise<{ outcome: "imported" | "updated" | "unchanged" | "failed" }> {
  const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
  // The webhook path obeys the same « Qui gère le stock ? » as the bulk sync (trackInventory ownership).
  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" }, select: { config: true } });
  const summary = emptySyncSummary();
  try {
    await syncOneProduct(client, wc, null, warehouse?.id ?? null, actor, summary, false, Boolean(options.restoreArchived), inventoryOwnerOf(integration?.config));
  } catch {
    return { outcome: "failed" };
  }
  if (summary.imported > 0) return { outcome: "imported" };
  if (summary.updated > 0) return { outcome: "updated" };
  if (summary.failed > 0) return { outcome: "failed" };
  return { outcome: "unchanged" };
}
