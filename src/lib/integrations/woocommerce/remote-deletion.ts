import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { notify, resolveNotifications } from "@/lib/notifications";
import type { WooCommerceClient } from "./client";
import { WooCommerceNotFoundError } from "./errors";
import type { RemoteDeletionMode } from "./store-settings";

/**
 * A local product linked to a WooCommerce product that the store deleted.
 *
 * Two kinds of link, both unlinked the same way the rest of the app already
 * defines « unlinked » (src/lib/integrations/shared/identity.ts):
 * - `imported`: Product.source = WOOCOMMERCE + externalId (imported or
 *   adopted) → becomes INTERNE / null, its WOOCOMMERCE variations too, and
 *   its publication row for that id (adoption creates one) is removed;
 * - `publication`: an ASODITECH product published to the store
 *   (ProductPublication) → that row is removed, so the product is eligible
 *   for publishing / export again.
 * Nothing else changes: the product, its status, variations, stock rows,
 * stock movements, orders and history stay exactly as they are. Reconnecting
 * stays the existing workflow — publish again, or let the next import re-link
 * the product by SKU (identity.ts).
 *
 * What counts as a reliable deletion: the store itself answering
 * `GET /products/{id}` with 404 + WooCommerce's own `woocommerce_rest_product_invalid_id`.
 * A product in the store's trash is reversible, and every other answer
 * (timeout, network, 401/403, 429, 5xx, a 404 without that slug — wrong URL,
 * disabled REST API —, a malformed body) proves nothing: those only ever lead
 * to manual review, never to an automatic unlink.
 *
 * State lives in the audit journal (no schema change): the product's latest
 * `product.remote_missing` / `_cleared` / `_unlinked` event says whether it
 * waits for a decision. Notifications use ERREUR_INTEGRATION with a dedupe
 * key, so a repeated webhook or check never notifies twice.
 */

export const WOO_PRODUCT_INVALID_ID = "woocommerce_rest_product_invalid_id";

export type RemoteProductCheck = "deleted" | "trashed" | "exists" | "unknown";

export async function checkWooCommerceProduct(client: WooCommerceClient | null, externalId: string): Promise<RemoteProductCheck> {
  if (!client || !/^\d+$/.test(externalId)) return "unknown";
  try {
    const product = await client.getProduct(Number(externalId));
    return product.status === "trash" ? "trashed" : "exists";
  } catch (error) {
    if (error instanceof WooCommerceNotFoundError && error.remoteCode === WOO_PRODUCT_INVALID_ID) return "deleted";
    return "unknown";
  }
}

export interface WooProductLink {
  productId: string;
  productName: string;
  externalId: string;
  kind: "imported" | "publication";
}

/** Every local product linked to this WooCommerce product id (imported/adopted, or published). */
export async function wooLinksForExternalId(externalId: string): Promise<WooProductLink[]> {
  const [imported, publications] = await Promise.all([
    prisma.product.findMany({ where: { source: "WOOCOMMERCE", externalId }, select: { id: true, name: true } }),
    prisma.productPublication.findMany({
      where: { provider: "WOOCOMMERCE", externalId },
      select: { productId: true, product: { select: { name: true } } },
    }),
  ]);
  const links = new Map<string, WooProductLink>();
  for (const p of imported) links.set(p.id, { productId: p.id, productName: p.name, externalId, kind: "imported" });
  for (const p of publications) {
    if (!links.has(p.productId)) links.set(p.productId, { productId: p.productId, productName: p.product.name, externalId, kind: "publication" });
  }
  return [...links.values()];
}

/** This product's WooCommerce link, if any. */
export async function wooLinkOfProduct(productId: string): Promise<WooProductLink | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId },
    select: { id: true, name: true, source: true, externalId: true, publications: { where: { provider: "WOOCOMMERCE" }, select: { externalId: true } } },
  });
  if (!product) return null;
  if (product.source === "WOOCOMMERCE" && product.externalId) {
    return { productId: product.id, productName: product.name, externalId: product.externalId, kind: "imported" };
  }
  const publication = product.publications[0];
  return publication ? { productId: product.id, productName: product.name, externalId: publication.externalId, kind: "publication" } : null;
}

const REMOTE_EVENTS = ["product.remote_missing", "product.remote_missing_cleared", "product.remote_unlinked"] as const;
const CHECKS: readonly RemoteProductCheck[] = ["deleted", "trashed", "exists", "unknown"];

export interface RemoteMissingFlag {
  externalId: string;
  check: RemoteProductCheck;
  detectedAt: Date;
}

/** The pending « supprimé de la boutique » flag of this link, or null (none, resolved, or about another remote id). */
export async function pendingRemoteMissing(
  link: Pick<WooProductLink, "productId" | "externalId">,
  db: PrismaTransactionClient | typeof prisma = prisma
): Promise<RemoteMissingFlag | null> {
  const last = await db.auditEvent.findFirst({
    where: { entityType: "Product", entityId: link.productId, action: { in: [...REMOTE_EVENTS] } },
    orderBy: { createdAt: "desc" },
    select: { action: true, metadata: true, createdAt: true },
  });
  if (!last || last.action !== "product.remote_missing") return null;
  const meta = (last.metadata ?? {}) as { provider?: unknown; externalId?: unknown; check?: unknown };
  if (meta.provider !== "WOOCOMMERCE" || meta.externalId !== link.externalId) return null;
  const check = CHECKS.includes(meta.check as RemoteProductCheck) ? (meta.check as RemoteProductCheck) : "unknown";
  return { externalId: link.externalId, check, detectedAt: last.createdAt };
}

export type RemoteActor = { type: "USER"; userId: string } | { type: "INTEGRATION" };

const auditActor = (actor: RemoteActor) =>
  actor.type === "USER" ? { actorType: "USER" as const, actorUserId: actor.userId } : { actorType: "INTEGRATION" as const };

const CHECK_PHRASES: Record<Exclude<RemoteProductCheck, "exists">, string> = {
  deleted: "n'existe plus sur la boutique WooCommerce",
  trashed: "a été mis à la corbeille sur la boutique WooCommerce",
  unknown: "a été signalé comme supprimé par la boutique WooCommerce (suppression non vérifiable pour le moment)",
};

/**
 * Reads the link's pending state and records the transition under a row lock
 * on the product (`SELECT … FOR UPDATE`, the codebase's pessimistic-lock
 * pattern): webhook retries racing each other are serialised, so the second
 * sees the first's event and records nothing — one event per transition.
 */
async function recordRemoteTransition(
  link: WooProductLink,
  shouldRecord: (pending: RemoteMissingFlag | null) => boolean,
  event: Omit<Parameters<typeof recordAuditEvent>[0], "entityType" | "entityId">
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "products" WHERE id = ${link.productId} FOR UPDATE`;
    if (!shouldRecord(await pendingRemoteMissing(link, tx))) return false;
    await recordAuditEvent({ ...event, entityType: "Product", entityId: link.productId }, tx);
    return true;
  });
}

/** Flags the link for manual review — once: an already pending flag is left as is (no second event, no second notification). */
export async function flagRemoteMissing(
  link: WooProductLink,
  check: Exclude<RemoteProductCheck, "exists">,
  ctx: { mode: RemoteDeletionMode; trigger: "webhook" | "check"; actor: RemoteActor }
): Promise<boolean> {
  const flagged = await recordRemoteTransition(link, (pending) => pending === null, {
    ...auditActor(ctx.actor),
    action: "product.remote_missing",
    metadata: { provider: "WOOCOMMERCE", externalId: link.externalId, link: link.kind, check, mode: ctx.mode, trigger: ctx.trigger },
  });
  if (!flagged) return false;
  await notify({
    type: "ERREUR_INTEGRATION",
    title: "Produit supprimé de WooCommerce",
    message: `« ${link.productName} » (WooCommerce #${link.externalId}) ${CHECK_PHRASES[check]}. Le produit, son stock et son historique sont conservés dans ASODITECH. Ouvrez la fiche produit pour confirmer la dissociation.`,
    entityType: "Product",
    entityId: link.productId,
    dedupeKey: `remote_missing:${link.productId}:${link.externalId}`,
    recipientPermission: "integrations.manage",
  });
  return true;
}

/** The store still has the product: a pending flag is closed (its notification removed). */
export async function clearRemoteMissing(link: WooProductLink, actor: RemoteActor): Promise<boolean> {
  const cleared = await recordRemoteTransition(link, (pending) => pending !== null, {
    ...auditActor(actor),
    action: "product.remote_missing_cleared",
    metadata: { provider: "WOOCOMMERCE", externalId: link.externalId, link: link.kind },
  });
  if (!cleared) return false;
  await resolveNotifications({ types: ["ERREUR_INTEGRATION"], entityType: "Product", entityId: link.productId });
  return true;
}

/**
 * Removes the link (see the file header for exactly what changes). Every
 * write is conditional on the link still being this one, in one
 * transaction: a second call — repeated webhook, double click — changes
 * nothing and records nothing. Returns whether this call unlinked.
 */
export async function unlinkWooProduct(
  link: WooProductLink,
  ctx: { mode: RemoteDeletionMode | "manual"; check: RemoteProductCheck; reason: "auto_confirmed_deletion" | "user_confirmed"; actor: RemoteActor }
): Promise<boolean> {
  const changed = await prisma.$transaction(async (tx) => {
    const product = await tx.product.updateMany({
      where: { id: link.productId, source: "WOOCOMMERCE", externalId: link.externalId },
      data: { source: "INTERNE", externalId: null },
    });
    const variations =
      product.count > 0
        ? await tx.productVariation.updateMany({ where: { productId: link.productId, source: "WOOCOMMERCE" }, data: { source: "INTERNE", externalId: null } })
        : { count: 0 };
    const publications = await tx.productPublication.deleteMany({
      where: { productId: link.productId, provider: "WOOCOMMERCE", externalId: link.externalId },
    });
    if (product.count + publications.count === 0) return false;
    await recordAuditEvent(
      {
        ...auditActor(ctx.actor),
        action: "product.remote_unlinked",
        entityType: "Product",
        entityId: link.productId,
        metadata: {
          provider: "WOOCOMMERCE",
          externalId: link.externalId,
          link: link.kind,
          mode: ctx.mode,
          check: ctx.check,
          reason: ctx.reason,
          unlinkedVariations: variations.count,
        },
      },
      tx
    );
    return true;
  });
  if (changed) await resolveNotifications({ types: ["ERREUR_INTEGRATION"], entityType: "Product", entityId: link.productId });
  return changed;
}

export type RemoteDeletionResult = "unlinked" | "flagged" | "already_flagged" | "exists" | "unknown" | "unchanged";

/**
 * One link + what the store answered → the company's rule:
 * - `exists`: nothing to do (a pending flag is closed);
 * - `deleted` and mode `auto`: unlinked, recorded, users informed;
 * - everything else (`deleted` in manual mode, `trashed`, `unknown`):
 *   flagged for an authorised user to confirm — except an `unknown` answer
 *   to a user's own check (`flagWhenUnknown: false`), which changes nothing:
 *   only the store's own deletion webhook justifies flagging an unverified case.
 */
export async function applyRemoteCheck(
  link: WooProductLink,
  check: RemoteProductCheck,
  ctx: { mode: RemoteDeletionMode; trigger: "webhook" | "check"; actor: RemoteActor; flagWhenUnknown: boolean }
): Promise<RemoteDeletionResult> {
  if (check === "exists") {
    await clearRemoteMissing(link, ctx.actor);
    return "exists";
  }
  if (check === "deleted" && ctx.mode === "auto") {
    const unlinked = await unlinkWooProduct(link, { mode: "auto", check, reason: "auto_confirmed_deletion", actor: ctx.actor });
    if (unlinked) {
      await notify({
        type: "ERREUR_INTEGRATION",
        title: "Produit dissocié de WooCommerce",
        message: `« ${link.productName} » (WooCommerce #${link.externalId}) a été supprimé de la boutique : il a été dissocié automatiquement. Le produit, son stock et son historique sont conservés dans ASODITECH.`,
        entityType: "Product",
        entityId: link.productId,
        dedupeKey: `remote_unlinked:${link.productId}:${link.externalId}`,
        recipientPermission: "integrations.manage",
      });
    }
    return unlinked ? "unlinked" : "unchanged";
  }
  if (check === "unknown" && !ctx.flagWhenUnknown) return "unknown";
  return (await flagRemoteMissing(link, check, ctx)) ? "flagged" : "already_flagged";
}

/**
 * The store's signed `product.deleted` webhook (fired for a trashed or a
 * permanently deleted product): every local link to that id is checked
 * against the store once, then handled by the company's rule. With no usable
 * client (disconnected, bad credentials) the answer is `unknown` → flagged.
 */
export async function handleWooProductDeletedWebhook(
  externalId: string,
  client: WooCommerceClient | null,
  mode: RemoteDeletionMode
): Promise<{ productId: string; check: RemoteProductCheck; result: RemoteDeletionResult }[]> {
  const links = await wooLinksForExternalId(externalId);
  if (links.length === 0) return [];
  const check = await checkWooCommerceProduct(client, externalId);
  const outcomes = [];
  for (const link of links) {
    const result = await applyRemoteCheck(link, check, { mode, trigger: "webhook", actor: { type: "INTEGRATION" }, flagWhenUnknown: true });
    outcomes.push({ productId: link.productId, check, result });
  }
  return outcomes;
}
