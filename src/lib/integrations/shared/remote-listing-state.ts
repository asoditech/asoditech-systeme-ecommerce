import {
  WooCommerceApiError,
  WooCommerceAuthError,
  WooCommerceConfigError,
  WooCommerceNotFoundError,
  WooCommercePermissionError,
  WooCommerceRateLimitError,
} from "@/lib/integrations/woocommerce/errors";
import {
  ShopifyAuthError,
  ShopifyConfigError,
  ShopifyNotFoundError,
  ShopifyPermissionError,
  ShopifyThrottledError,
  ShopifyUserError,
} from "@/lib/integrations/shopify/errors";
import { PROVIDER_LABEL, type RemoteProvider } from "./remote-product-labels";

/**
 * Pure part of the OUTBOUND remote product lifecycle (remote-listing.ts):
 * « Retirer de la boutique » / « Remettre en vente ». No Prisma, no network —
 * unit-tested directly (tests/lib/remote-listing-state.test.ts).
 */

export type ListingOp = "withdraw" | "republish";
/** What the store shows: on sale, withdrawn (draft / archived / private…), or gone (deleted / trashed). */
export type RemoteListing = "live" | "withdrawn" | "missing";

export const TARGET_OF: Record<ListingOp, RemoteListing> = { withdraw: "withdrawn", republish: "live" };

/** WooCommerce post status → listing. `trash` is not a listing ASODITECH manages: the inbound rule handles it. */
export function wooListingOf(status: string): RemoteListing {
  if (status === "publish") return "live";
  if (status === "trash") return "missing";
  return "withdrawn"; // draft | pending | private | future…
}

/** Shopify ProductStatus → listing (`null` product = deleted). UNLISTED (2025-10+) is still on sale by direct link. */
export function shopifyListingOf(status: string | null): RemoteListing {
  if (status === null) return "missing";
  if (status === "ACTIVE" || status === "UNLISTED") return "live";
  return "withdrawn"; // ARCHIVED | DRAFT
}

/**
 * What a failed store call means for a state-changing request:
 * - `denied` (401/403, missing scope) and `config`: certainly not applied;
 * - `rate_limited` (429 / THROTTLED: the store refused before executing):
 *   not applied — retry later;
 * - `rejected` (a 4xx / userErrors the store answered with): not applied;
 * - `uncertain` (timeout, network reset, 5xx, unreadable 2xx, anything
 *   unknown): the request may have reached the store — NEVER assumed
 *   either way; recorded « à vérifier » and resolved only by re-reading.
 */
export type RemoteFailure = "denied" | "rate_limited" | "rejected" | "config" | "uncertain";

export function classifyRemoteFailure(error: unknown): RemoteFailure {
  if (error instanceof WooCommerceAuthError || error instanceof WooCommercePermissionError) return "denied";
  if (error instanceof ShopifyAuthError || error instanceof ShopifyPermissionError) return "denied";
  if (error instanceof WooCommerceRateLimitError || error instanceof ShopifyThrottledError) return "rate_limited";
  if (error instanceof WooCommerceApiError || error instanceof WooCommerceNotFoundError) return "rejected";
  if (error instanceof ShopifyUserError || error instanceof ShopifyNotFoundError) return "rejected";
  if (error instanceof WooCommerceConfigError || error instanceof ShopifyConfigError) return "config";
  return "uncertain";
}

/** French, user-facing — never the store's raw text, a status body, a URL or a credential. */
export function failureMessage(provider: RemoteProvider, failure: RemoteFailure, stage: "read" | "write"): string {
  const label = PROVIDER_LABEL[provider];
  if (failure === "denied") {
    return `Accès refusé par ${label} : la clé / le jeton de la connexion n'a pas les permissions d'écriture sur les produits. Rien n'a été modifié.`;
  }
  if (failure === "rate_limited") return `${label} limite temporairement les requêtes. Rien n'a été modifié : réessayez dans un instant.`;
  if (failure === "rejected") return `${label} a refusé la demande. Rien n'a été modifié.`;
  if (failure === "config") return `Connexion ${label} non configurée ou identifiants incomplets.`;
  return stage === "read"
    ? `Impossible de lire l'état du produit sur ${label} pour le moment. Rien n'a été envoyé : réessayez plus tard.`
    : `Résultat incertain : ${label} n'a pas répondu clairement. La demande a peut-être été appliquée — rien n'est renvoyé automatiquement. Cliquez sur « Vérifier l'état sur la boutique ».`;
}

export const LISTING_EVENTS = [
  "product.remote_listing_requested",
  "product.remote_listing_changed",
  "product.remote_listing_failed",
  "product.remote_listing_uncertain",
  "product.remote_listing_reconciled",
] as const;
export type ListingEventAction = (typeof LISTING_EVENTS)[number];

/** A request older than this without an outcome (crash, killed function) is « à vérifier », never retried. */
export const IN_FLIGHT_MS = 2 * 60 * 1000;

export interface ListingJournalEvent {
  action: string;
  metadata: unknown;
  createdAt: Date;
}

export type ListingPhase = "idle" | "in_progress" | "uncertain";

export interface ListingState {
  phase: ListingPhase;
  /** The last listing the store CONFIRMED (written or re-read), if any. */
  listing: RemoteListing | null;
  /** The pending operation when `in_progress` / `uncertain`. */
  op: ListingOp | null;
  since: Date | null;
  /** The last definite failure's class, when it is the latest event. */
  lastFailure: RemoteFailure | null;
}

const OPS: readonly string[] = ["withdraw", "republish"];
const LISTINGS: readonly string[] = ["live", "withdrawn", "missing"];

/**
 * The outbound state of one link from its journal (any order; only events
 * of this provider + remote id count). The latest event decides the phase;
 * the latest `changed` / `reconciled` gives the confirmed listing.
 */
export function deriveListingState(
  events: readonly ListingJournalEvent[],
  link: { provider: RemoteProvider; externalId: string },
  now: Date = new Date()
): ListingState {
  const mine = events
    .filter((e) => {
      const meta = (e.metadata ?? {}) as { provider?: unknown; externalId?: unknown };
      return (LISTING_EVENTS as readonly string[]).includes(e.action) && meta.provider === link.provider && meta.externalId === link.externalId;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const confirmed = mine.find((e) => e.action === "product.remote_listing_changed" || e.action === "product.remote_listing_reconciled");
  const confirmedListing = (confirmed?.metadata as { remoteListing?: unknown } | undefined)?.remoteListing;
  const listing = typeof confirmedListing === "string" && LISTINGS.includes(confirmedListing) ? (confirmedListing as RemoteListing) : null;

  const latest = mine[0];
  const base: ListingState = { phase: "idle", listing, op: null, since: null, lastFailure: null };
  if (!latest) return base;
  const meta = (latest.metadata ?? {}) as { op?: unknown; failure?: unknown };
  const op = typeof meta.op === "string" && OPS.includes(meta.op) ? (meta.op as ListingOp) : null;

  if (latest.action === "product.remote_listing_requested") {
    const inFlight = now.getTime() - latest.createdAt.getTime() < IN_FLIGHT_MS;
    return { ...base, phase: inFlight ? "in_progress" : "uncertain", op, since: latest.createdAt };
  }
  if (latest.action === "product.remote_listing_uncertain") return { ...base, phase: "uncertain", op, since: latest.createdAt };
  if (latest.action === "product.remote_listing_failed") {
    const failure = typeof meta.failure === "string" ? (meta.failure as RemoteFailure) : null;
    return { ...base, lastFailure: failure, since: latest.createdAt };
  }
  return { ...base, since: latest.createdAt };
}
