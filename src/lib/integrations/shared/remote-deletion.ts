import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { recordAuditEvent } from "@/lib/audit";
import { notify, resolveNotifications } from "@/lib/notifications";
import type { RemoteDeletionMode } from "@/lib/integrations/woocommerce/store-settings";
import type { StoreProvider } from "./identity";
import { PROVIDER_LABEL, remoteIdLabel } from "./remote-product-labels";
import { isRestorableArchiveEvent, type RemoteArchiveReason } from "./remote-archive";

export { isRestorableArchiveEvent, type RemoteArchiveReason };

/**
 * INBOUND remote product lifecycle, shared by WooCommerce and Shopify — a
 * product the connected store deleted (docs: src/lib/integrations/woocommerce/remote-deletion.ts
 * for the original WooCommerce rule, src/lib/integrations/shopify/remote-deletion.ts
 * for Shopify's proof of deletion).
 *
 * Two kinds of link, both unlinked the way src/lib/integrations/shared/identity.ts
 * defines « unlinked »:
 * - `imported`: Product.source = provider + externalId (imported or adopted)
 *   → becomes INTERNE / null, its variations of that provider too, and its
 *   publication row for that id is removed;
 * - `publication`: an ASODITECH product published to the store
 *   (ProductPublication) → that row is removed.
 * Nothing else changes: the product, its status, variations, stock rows,
 * stock movements, orders, refunds and audit history stay exactly as they are.
 *
 * State lives in the audit journal (no schema change): the product's latest
 * `product.remote_missing` / `_cleared` / `_unlinked` event OF THAT PROVIDER
 * says whether it waits for a decision — a product linked to both stores
 * keeps one independent state per store.
 */

export type RemoteProductCheck = "deleted" | "trashed" | "exists" | "unknown";

export interface RemoteProductLink {
  provider: StoreProvider;
  productId: string;
  productName: string;
  externalId: string;
  kind: "imported" | "publication";
}

/** Every local product linked to this store product id (imported/adopted, or published). */
export async function remoteLinksForExternalId(provider: StoreProvider, externalId: string): Promise<RemoteProductLink[]> {
  const [imported, publications] = await Promise.all([
    prisma.product.findMany({ where: { source: provider, externalId }, select: { id: true, name: true } }),
    prisma.productPublication.findMany({
      where: { provider, externalId },
      select: { productId: true, product: { select: { name: true } } },
    }),
  ]);
  const links = new Map<string, RemoteProductLink>();
  for (const p of imported) links.set(p.id, { provider, productId: p.id, productName: p.name, externalId, kind: "imported" });
  for (const p of publications) {
    if (!links.has(p.productId)) links.set(p.productId, { provider, productId: p.productId, productName: p.product.name, externalId, kind: "publication" });
  }
  return [...links.values()];
}

/** This product's link to `provider`, if any. */
export async function remoteLinkOfProduct(provider: StoreProvider, productId: string): Promise<RemoteProductLink | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId },
    select: { id: true, name: true, source: true, externalId: true, publications: { where: { provider }, select: { externalId: true } } },
  });
  if (!product) return null;
  if (product.source === provider && product.externalId) {
    return { provider, productId: product.id, productName: product.name, externalId: product.externalId, kind: "imported" };
  }
  const publication = product.publications[0];
  return publication ? { provider, productId: product.id, productName: product.name, externalId: publication.externalId, kind: "publication" } : null;
}

const REMOTE_EVENTS = ["product.remote_missing", "product.remote_missing_cleared", "product.remote_unlinked"] as const;
const CHECKS: readonly RemoteProductCheck[] = ["deleted", "trashed", "exists", "unknown"];
/** Bounded read of the product's remote-link journal (it holds a handful of events per store at most). */
const JOURNAL_WINDOW = 50;

export interface RemoteMissingFlag {
  externalId: string;
  check: RemoteProductCheck;
  detectedAt: Date;
}

/** The pending « supprimé de la boutique » flag of this link, or null (none, resolved, or about another remote id). */
export async function pendingRemoteMissingOf(
  link: Pick<RemoteProductLink, "provider" | "productId" | "externalId">,
  db: PrismaTransactionClient | typeof prisma = prisma
): Promise<RemoteMissingFlag | null> {
  const events = await db.auditEvent.findMany({
    where: { entityType: "Product", entityId: link.productId, action: { in: [...REMOTE_EVENTS] } },
    orderBy: { createdAt: "desc" },
    take: JOURNAL_WINDOW,
    select: { action: true, metadata: true, createdAt: true },
  });
  const last = events.find((e) => ((e.metadata ?? {}) as { provider?: unknown }).provider === link.provider);
  if (!last || last.action !== "product.remote_missing") return null;
  const meta = (last.metadata ?? {}) as { externalId?: unknown; check?: unknown };
  if (meta.externalId !== link.externalId) return null;
  const check = CHECKS.includes(meta.check as RemoteProductCheck) ? (meta.check as RemoteProductCheck) : "unknown";
  return { externalId: link.externalId, check, detectedAt: last.createdAt };
}

export type RemoteActor = { type: "USER"; userId: string } | { type: "INTEGRATION" };

export const auditActor = (actor: RemoteActor) =>
  actor.type === "USER" ? { actorType: "USER" as const, actorUserId: actor.userId } : { actorType: "INTEGRATION" as const };

function checkPhrase(provider: StoreProvider, check: Exclude<RemoteProductCheck, "exists">): string {
  const label = PROVIDER_LABEL[provider];
  if (check === "deleted") return `n'existe plus sur la boutique ${label}`;
  if (check === "trashed") return `a été mis à la corbeille sur la boutique ${label}`;
  return `a été signalé comme supprimé par la boutique ${label} (suppression non vérifiable pour le moment)`;
}

/**
 * Reads the link's pending state and records the transition under a row lock
 * on the product (`SELECT … FOR UPDATE`, the codebase's pessimistic-lock
 * pattern): webhook retries racing each other are serialised, so the second
 * sees the first's event and records nothing — one event per transition.
 */
async function recordRemoteTransition(
  link: RemoteProductLink,
  shouldRecord: (pending: RemoteMissingFlag | null) => boolean,
  event: Omit<Parameters<typeof recordAuditEvent>[0], "entityType" | "entityId">
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "products" WHERE id = ${link.productId} FOR UPDATE`;
    if (!shouldRecord(await pendingRemoteMissingOf(link, tx))) return false;
    await recordAuditEvent({ ...event, entityType: "Product", entityId: link.productId }, tx);
    return true;
  });
}

/** Flags the link for manual review — once: an already pending flag is left as is (no second event, no second notification). */
export async function flagRemoteMissingLink(
  link: RemoteProductLink,
  check: Exclude<RemoteProductCheck, "exists">,
  ctx: { mode: RemoteDeletionMode; trigger: "webhook" | "check"; actor: RemoteActor }
): Promise<boolean> {
  const flagged = await recordRemoteTransition(link, (pending) => pending === null, {
    ...auditActor(ctx.actor),
    action: "product.remote_missing",
    metadata: { provider: link.provider, externalId: link.externalId, link: link.kind, check, mode: ctx.mode, trigger: ctx.trigger },
  });
  if (!flagged) return false;
  const label = PROVIDER_LABEL[link.provider];
  await notify({
    type: "ERREUR_INTEGRATION",
    title: `Produit supprimé de ${label}`,
    message: `« ${link.productName} » (${label} ${remoteIdLabel(link.provider, link.externalId)}) ${checkPhrase(link.provider, check)}. Le produit, son stock et son historique sont conservés dans ASODITECH. Ouvrez la fiche produit pour confirmer la dissociation.`,
    entityType: "Product",
    entityId: link.productId,
    dedupeKey: `remote_missing:${link.productId}:${link.externalId}`,
    recipientPermission: "integrations.manage",
  });
  return true;
}

/** The store still has the product: a pending flag is closed (its notification removed). */
export async function clearRemoteMissingLink(link: RemoteProductLink, actor: RemoteActor): Promise<boolean> {
  const cleared = await recordRemoteTransition(link, (pending) => pending !== null, {
    ...auditActor(actor),
    action: "product.remote_missing_cleared",
    metadata: { provider: link.provider, externalId: link.externalId, link: link.kind },
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
export async function unlinkRemoteProduct(
  link: RemoteProductLink,
  ctx: { mode: RemoteDeletionMode | "manual"; check: RemoteProductCheck; reason: "auto_confirmed_deletion" | "user_confirmed"; actor: RemoteActor }
): Promise<boolean> {
  const changed = await prisma.$transaction(async (tx) => {
    const product = await tx.product.updateMany({
      where: { id: link.productId, source: link.provider, externalId: link.externalId },
      data: { source: "INTERNE", externalId: null },
    });
    const variations =
      product.count > 0
        ? await tx.productVariation.updateMany({ where: { productId: link.productId, source: link.provider }, data: { source: "INTERNE", externalId: null } })
        : { count: 0 };
    const publications = await tx.productPublication.deleteMany({
      where: { productId: link.productId, provider: link.provider, externalId: link.externalId },
    });
    if (product.count + publications.count === 0) return false;
    await recordAuditEvent(
      {
        ...auditActor(ctx.actor),
        action: "product.remote_unlinked",
        entityType: "Product",
        entityId: link.productId,
        metadata: {
          provider: link.provider,
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
 * One link + what the store answered → the company's rule (same for both stores):
 * - `exists`: nothing to do (a pending flag is closed);
 * - `deleted` and mode `auto`: unlinked, recorded, users informed;
 * - everything else (`deleted` in manual mode, `trashed`, `unknown`):
 *   flagged for an authorised user to confirm — except an `unknown` answer
 *   to a user's own check (`flagWhenUnknown: false`), which changes nothing:
 *   only the store's own deletion webhook justifies flagging an unverified case.
 */
export async function applyRemoteProductCheck(
  link: RemoteProductLink,
  check: RemoteProductCheck,
  ctx: { mode: RemoteDeletionMode; trigger: "webhook" | "check"; actor: RemoteActor; flagWhenUnknown: boolean }
): Promise<RemoteDeletionResult> {
  if (check === "exists") {
    await clearRemoteMissingLink(link, ctx.actor);
    return "exists";
  }
  if (check === "deleted" && ctx.mode === "auto") {
    const unlinked = await unlinkRemoteProduct(link, { mode: "auto", check, reason: "auto_confirmed_deletion", actor: ctx.actor });
    if (unlinked) {
      const label = PROVIDER_LABEL[link.provider];
      await notify({
        type: "ERREUR_INTEGRATION",
        title: `Produit dissocié de ${label}`,
        message: `« ${link.productName} » (${label} ${remoteIdLabel(link.provider, link.externalId)}) a été supprimé de la boutique : il a été dissocié automatiquement. Le produit, son stock et son historique sont conservés dans ASODITECH.`,
        entityType: "Product",
        entityId: link.productId,
        dedupeKey: `remote_unlinked:${link.productId}:${link.externalId}`,
        recipientPermission: "integrations.manage",
      });
    }
    return unlinked ? "unlinked" : "unchanged";
  }
  if (check === "unknown" && !ctx.flagWhenUnknown) return "unknown";
  return (await flagRemoteMissingLink(link, check, ctx)) ? "flagged" : "already_flagged";
}

// ---------------------------------------------------------------------------
// Local archive caused by the store, and its restore.
// ---------------------------------------------------------------------------

/**
 * Archives a store-linked product because of the store (deleted, or archived
 * there) — never deletes it: order lines, stock movements, refunds and the
 * audit journal keep pointing at it. Audited as `product.archived` by the
 * INTEGRATION with the reason, which is exactly what `remoteArchiveIsRestorable`
 * reads back. No-op (false) when the product is already archived — an
 * existing archive, manual or not, keeps its own cause.
 */
export async function archiveForRemote(productId: string, provider: StoreProvider, reason: RemoteArchiveReason): Promise<boolean> {
  const moved = await prisma.product.updateMany({ where: { id: productId, status: { not: "ARCHIVE" } }, data: { status: "ARCHIVE" } });
  if (moved.count === 0) return false;
  await recordRemoteArchive(productId, provider, reason);
  return true;
}

/** The audit half of `archiveForRemote`, for a sync that already wrote ARCHIVE itself (the store's own ARCHIVED status). */
export async function recordRemoteArchive(productId: string, provider: StoreProvider, reason: RemoteArchiveReason): Promise<void> {
  await recordAuditEvent({
    actorType: "INTEGRATION",
    action: "product.archived",
    entityType: "Product",
    entityId: productId,
    metadata: { source: provider, reason },
  });
}

/**
 * Whether the product's CURRENT archive was caused by `provider` (deletion or
 * archive on the store) and may therefore be lifted when the store proves the
 * product is live again. The latest `product.archived` event decides: a user
 * who archived it (product page, « Retirer », edit form) after — or instead of
 * — the store always wins, so a manual archive is never undone. A product
 * archived without any event (legacy rows) is never restored automatically.
 */
export async function remoteArchiveIsRestorable(
  productId: string,
  provider: StoreProvider,
  db: PrismaTransactionClient | typeof prisma = prisma
): Promise<boolean> {
  const last = await db.auditEvent.findFirst({
    where: { entityType: "Product", entityId: productId, action: "product.archived" },
    orderBy: { createdAt: "desc" },
    select: { actorType: true, metadata: true },
  });
  return isRestorableArchiveEvent(last, provider);
}

/** Records that the store's proof lifted an archive it had caused. */
export async function recordRemoteRestore(productId: string, provider: StoreProvider, reason: "restored_upstream" | "active_upstream"): Promise<void> {
  await recordAuditEvent({
    actorType: "INTEGRATION",
    action: "product.restored",
    entityType: "Product",
    entityId: productId,
    metadata: { source: provider, reason },
  });
}
