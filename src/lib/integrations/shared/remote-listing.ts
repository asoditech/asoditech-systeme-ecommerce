import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { loadShopifyClient } from "@/lib/integrations/shopify/client-loader";
import { WooCommerceNotFoundError } from "@/lib/integrations/woocommerce/errors";
import { WOO_PRODUCT_INVALID_ID } from "@/lib/integrations/woocommerce/remote-deletion";
import type { RemoteProductLink } from "./remote-deletion";
import {
  classifyRemoteFailure,
  deriveListingState,
  failureMessage,
  LISTING_EVENTS,
  shopifyListingOf,
  TARGET_OF,
  wooListingOf,
  type ListingOp,
  type ListingState,
  type RemoteFailure,
  type RemoteListing,
} from "./remote-listing-state";
import { PROVIDER_LABEL } from "./remote-product-labels";

/**
 * OUTBOUND remote product lifecycle — « Retirer de la boutique » and
 * « Remettre en vente » for a product ASODITECH published (or adopted) on a
 * connected store. One SOFT, reversible operation per store, never a
 * permanent deletion:
 * - WooCommerce REST v3: `PUT /products/{id} { status: "draft" }` (back:
 *   `publish`). Not `DELETE` — neither the trash nor `force=true`.
 * - Shopify Admin GraphQL 2026-07: `productUpdate(product: { id, status:
 *   ARCHIVED })` (back: ACTIVE). Not `productDelete` (irreversible).
 * Locally NOTHING is deleted or rewritten here: the product, its
 * variations, stock, movements, orders, refunds, the publication row and
 * the audit journal stay. (The store's new status reaches the local status
 * through the normal sync — field ownership.)
 *
 * Safety (no schema change — the audit journal is the state, read by the
 * pure `deriveListingState`):
 * 1. The store is ALWAYS read first. Already in the target state → recorded
 *    as confirmed, nothing sent (idempotent: a retry, a double click or a
 *    second tab never sends a second change).
 * 2. A `requested` event is recorded under a row lock before the single
 *    call; a concurrent request sees it and is refused. A request left
 *    without an outcome (crash) becomes « à vérifier » after IN_FLIGHT_MS.
 * 3. Exactly ONE attempt (clients' `retry: false` / `attempts: 1`).
 *    401/403, 429/THROTTLED, a 4xx/userError → `failed`, visible, nothing
 *    changed. Timeout, network reset, 5xx, unreadable 2xx → `uncertain`
 *    (« à vérifier »), never re-sent automatically.
 * 4. Reconciliation = re-reading the store (`reconcileRemoteListing`), which
 *    records what it actually shows.
 */

export interface ListingAdapter {
  provider: RemoteProductLink["provider"];
  read(externalId: string): Promise<RemoteListing>;
  write(externalId: string, op: ListingOp): Promise<RemoteListing>;
}

/** The store adapter of the current tenant's connection, or null (not configured / invalid address). */
export async function loadListingAdapter(provider: RemoteProductLink["provider"]): Promise<ListingAdapter | null> {
  if (provider === "WOOCOMMERCE") {
    let loaded: Awaited<ReturnType<typeof loadWooCommerceClient>> = null;
    try {
      loaded = await loadWooCommerceClient();
    } catch {
      return null;
    }
    return loaded ? wooListingAdapter(loaded.client) : null;
  }
  let loaded: Awaited<ReturnType<typeof loadShopifyClient>> = null;
  try {
    loaded = await loadShopifyClient();
  } catch {
    return null;
  }
  return loaded ? shopifyListingAdapter(loaded.client) : null;
}

type WooLike = { getProduct(id: number): Promise<{ status: string }>; setProductStatus(id: number, status: "draft" | "publish"): Promise<{ status: string }> };
type ShopifyLike = {
  getProductStatus(gid: string): Promise<{ status: string } | null>;
  setProductStatus(gid: string, status: "ACTIVE" | "ARCHIVED" | "DRAFT"): Promise<{ status: string }>;
};

export function wooListingAdapter(client: WooLike): ListingAdapter {
  const id = (externalId: string) => {
    if (!/^\d+$/.test(externalId)) throw new WooCommerceNotFoundError("Identifiant WooCommerce invalide.");
    return Number(externalId);
  };
  return {
    provider: "WOOCOMMERCE",
    async read(externalId) {
      try {
        return wooListingOf((await client.getProduct(id(externalId))).status);
      } catch (error) {
        if (error instanceof WooCommerceNotFoundError && error.remoteCode === WOO_PRODUCT_INVALID_ID) return "missing";
        throw error;
      }
    },
    async write(externalId, op) {
      return wooListingOf((await client.setProductStatus(id(externalId), op === "withdraw" ? "draft" : "publish")).status);
    },
  };
}

export function shopifyListingAdapter(client: ShopifyLike): ListingAdapter {
  return {
    provider: "SHOPIFY",
    async read(gid) {
      return shopifyListingOf((await client.getProductStatus(gid))?.status ?? null);
    },
    async write(gid, op) {
      return shopifyListingOf((await client.setProductStatus(gid, op === "withdraw" ? "ARCHIVED" : "ACTIVE")).status);
    },
  };
}

const JOURNAL_WINDOW = 50;

async function journalOf(productId: string, db: PrismaTransactionClient | typeof prisma = prisma) {
  return db.auditEvent.findMany({
    where: { entityType: "Product", entityId: productId, action: { in: [...LISTING_EVENTS] } },
    orderBy: { createdAt: "desc" },
    take: JOURNAL_WINDOW,
    select: { action: true, metadata: true, createdAt: true },
  });
}

/** The outbound state of this link (database only, no store call). */
export async function remoteListingStateOf(link: Pick<RemoteProductLink, "provider" | "productId" | "externalId">): Promise<ListingState> {
  return deriveListingState(await journalOf(link.productId), link);
}

/** Records one journal event under a row lock on the product, only if `guard` accepts the current state. */
async function recordListingEvent(
  link: RemoteProductLink,
  userId: string,
  action: (typeof LISTING_EVENTS)[number],
  metadata: Record<string, string | boolean | null>,
  guard: (state: ListingState) => boolean = () => true
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "products" WHERE id = ${link.productId} FOR UPDATE`;
    if (!guard(deriveListingState(await journalOf(link.productId, tx), link))) return false;
    await recordAuditEvent(
      {
        actorType: "USER",
        actorUserId: userId,
        action,
        entityType: "Product",
        entityId: link.productId,
        metadata: { provider: link.provider, externalId: link.externalId, link: link.kind, ...metadata },
      },
      tx
    );
    return true;
  });
}

export type ListingChangeResult =
  | { ok: true; outcome: "changed" | "already"; listing: RemoteListing }
  | { ok: false; outcome: "busy" | "missing" | "read_failed" | "failed" | "uncertain"; failure?: RemoteFailure; message: string };

export async function changeRemoteListing(link: RemoteProductLink, op: ListingOp, userId: string, adapter: ListingAdapter): Promise<ListingChangeResult> {
  const label = PROVIDER_LABEL[link.provider];
  const target = TARGET_OF[op];
  const before = await remoteListingStateOf(link);
  if (before.phase === "in_progress") {
    return { ok: false, outcome: "busy", message: "Une opération sur ce produit est déjà en cours sur la boutique. Patientez puis vérifiez son état." };
  }

  // 1. Read first — this is also the reconciliation of a pending « à vérifier ».
  let current: RemoteListing;
  try {
    current = await adapter.read(link.externalId);
  } catch (error) {
    const failure = classifyRemoteFailure(error);
    return { ok: false, outcome: "read_failed", failure, message: failureMessage(link.provider, failure === "uncertain" ? "uncertain" : failure, "read") };
  }
  if (current === "missing") {
    if (before.phase === "uncertain") await recordListingEvent(link, userId, "product.remote_listing_reconciled", { op: before.op, remoteListing: "missing", applied: null });
    return {
      ok: false,
      outcome: "missing",
      message: `Ce produit n'existe plus (ou est à la corbeille) sur ${label} : rien n'a été envoyé. Utilisez « Vérifier sur la boutique » pour décider du lien.`,
    };
  }
  if (current === target) {
    // Recorded once: a repeated click on an already-confirmed state adds nothing to the journal.
    await recordListingEvent(link, userId, "product.remote_listing_changed", { op, remoteListing: current, already: true }, (state) => state.phase !== "idle" || state.listing !== current);
    return { ok: true, outcome: "already", listing: current };
  }
  if (before.phase === "uncertain") {
    // The previous, unconfirmed request did not take effect: recorded, then this explicit request proceeds.
    await recordListingEvent(link, userId, "product.remote_listing_reconciled", { op: before.op, remoteListing: current, applied: before.op ? TARGET_OF[before.op] === current : null });
  }

  // 2. Claim the operation (a concurrent request sees it and stops).
  const claimed = await recordListingEvent(link, userId, "product.remote_listing_requested", { op }, (state) => state.phase !== "in_progress");
  if (!claimed) {
    return { ok: false, outcome: "busy", message: "Une opération sur ce produit est déjà en cours sur la boutique. Patientez puis vérifiez son état." };
  }

  // 3. Exactly one attempt.
  try {
    const after = await adapter.write(link.externalId, op);
    if (after !== target) {
      await recordListingEvent(link, userId, "product.remote_listing_uncertain", { op, failure: "uncertain" });
      return { ok: false, outcome: "uncertain", failure: "uncertain", message: failureMessage(link.provider, "uncertain", "write") };
    }
    await recordListingEvent(link, userId, "product.remote_listing_changed", { op, remoteListing: after, already: false });
    return { ok: true, outcome: "changed", listing: after };
  } catch (error) {
    const failure = classifyRemoteFailure(error);
    if (failure === "uncertain") {
      await recordListingEvent(link, userId, "product.remote_listing_uncertain", { op, failure });
      return { ok: false, outcome: "uncertain", failure, message: failureMessage(link.provider, failure, "write") };
    }
    await recordListingEvent(link, userId, "product.remote_listing_failed", { op, failure });
    return { ok: false, outcome: "failed", failure, message: failureMessage(link.provider, failure, "write") };
  }
}

export type ListingReconcileResult =
  | { ok: true; listing: RemoteListing; resolved: boolean }
  | { ok: false; outcome: "busy" | "read_failed"; failure?: RemoteFailure; message: string };

/**
 * « Vérifier l'état sur la boutique »: re-reads the store and records what it
 * shows — the only way an « à vérifier » request is resolved. Never sends a change.
 */
export async function reconcileRemoteListing(link: RemoteProductLink, userId: string, adapter: ListingAdapter): Promise<ListingReconcileResult> {
  const before = await remoteListingStateOf(link);
  if (before.phase === "in_progress") {
    return { ok: false, outcome: "busy", message: "Une opération sur ce produit est déjà en cours sur la boutique. Patientez quelques instants." };
  }
  let current: RemoteListing;
  try {
    current = await adapter.read(link.externalId);
  } catch (error) {
    const failure = classifyRemoteFailure(error);
    return { ok: false, outcome: "read_failed", failure, message: failureMessage(link.provider, failure, "read") };
  }
  const resolved = before.phase === "uncertain";
  await recordListingEvent(
    link,
    userId,
    "product.remote_listing_reconciled",
    { op: before.op, remoteListing: current, applied: resolved && before.op ? TARGET_OF[before.op] === current : null },
    // Never over an operation that started meanwhile; nothing new to record when the state is already known.
    (state) => state.phase !== "in_progress" && (state.phase !== "idle" || state.listing !== current)
  );
  return { ok: true, listing: current, resolved };
}
