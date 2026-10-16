import { describe, expect, it } from "vitest";
import {
  classifyRemoteFailure,
  deriveListingState,
  failureMessage,
  IN_FLIGHT_MS,
  shopifyListingOf,
  wooListingOf,
} from "@/lib/integrations/shared/remote-listing-state";
import { isRestorableArchiveEvent } from "@/lib/integrations/shared/remote-archive";
import { REMOTE_OPERATION_SUPPORT, remoteIdLabel } from "@/lib/integrations/shared/remote-product-labels";
import {
  WooCommerceApiError,
  WooCommerceAuthError,
  WooCommerceMalformedResponseError,
  WooCommerceNotFoundError,
  WooCommercePermissionError,
  WooCommerceRateLimitError,
  WooCommerceTimeoutError,
  WooCommerceUnavailableError,
} from "@/lib/integrations/woocommerce/errors";
import {
  ShopifyAuthError,
  ShopifyMalformedResponseError,
  ShopifyPermissionError,
  ShopifyThrottledError,
  ShopifyTimeoutError,
  ShopifyUnavailableError,
  ShopifyUserError,
} from "@/lib/integrations/shopify/errors";

/**
 * Pure rules of the remote product lifecycle (no database, no network):
 * store status → listing, failure classes (never assume success or failure
 * on an uncertain outcome), the journal → state machine, and which archive
 * a store may lift.
 */

describe("store status → listing", () => {
  it("WooCommerce: publish is on sale, trash is gone, every other post status is withdrawn", () => {
    expect(wooListingOf("publish")).toBe("live");
    expect(wooListingOf("trash")).toBe("missing");
    for (const s of ["draft", "pending", "private", "future"]) expect(wooListingOf(s)).toBe("withdrawn");
  });
  it("Shopify: ACTIVE / UNLISTED on sale, ARCHIVED / DRAFT withdrawn, null product = deleted", () => {
    expect(shopifyListingOf("ACTIVE")).toBe("live");
    expect(shopifyListingOf("UNLISTED")).toBe("live");
    expect(shopifyListingOf("ARCHIVED")).toBe("withdrawn");
    expect(shopifyListingOf("DRAFT")).toBe("withdrawn");
    expect(shopifyListingOf(null)).toBe("missing");
  });
});

describe("failure classes", () => {
  const msg = "x";
  it("permission failures are definite (nothing applied)", () => {
    for (const e of [new WooCommerceAuthError(msg), new WooCommercePermissionError(msg), new ShopifyAuthError(msg), new ShopifyPermissionError(msg)]) {
      expect(classifyRemoteFailure(e)).toBe("denied");
    }
  });
  it("rate limits are definite (the store refused before executing)", () => {
    expect(classifyRemoteFailure(new WooCommerceRateLimitError(msg))).toBe("rate_limited");
    expect(classifyRemoteFailure(new ShopifyThrottledError(msg))).toBe("rate_limited");
  });
  it("a store's own rejection (4xx, userErrors) is definite", () => {
    expect(classifyRemoteFailure(new WooCommerceApiError(msg, 400, "rest_invalid_param", undefined))).toBe("rejected");
    expect(classifyRemoteFailure(new WooCommerceNotFoundError(msg, "woocommerce_rest_product_invalid_id"))).toBe("rejected");
    expect(classifyRemoteFailure(new ShopifyUserError(msg))).toBe("rejected");
  });
  it("timeout, network reset, 5xx, unreadable 2xx and anything unknown are uncertain — never assumed", () => {
    for (const e of [
      new WooCommerceTimeoutError(msg),
      new WooCommerceUnavailableError(msg),
      new WooCommerceMalformedResponseError(msg),
      new ShopifyTimeoutError(msg),
      new ShopifyUnavailableError(msg),
      new ShopifyMalformedResponseError(msg),
      new TypeError("fetch failed"),
      "weird",
    ]) {
      expect(classifyRemoteFailure(e)).toBe("uncertain");
    }
  });
  it("messages are French, name the store, and say what happened locally — never a raw body", () => {
    expect(failureMessage("SHOPIFY", "denied", "write")).toMatch(/Accès refusé par Shopify.*Rien n'a été modifié/);
    expect(failureMessage("WOOCOMMERCE", "rate_limited", "write")).toMatch(/WooCommerce limite.*Rien n'a été modifié/);
    expect(failureMessage("SHOPIFY", "uncertain", "write")).toMatch(/Résultat incertain.*rien n'est renvoyé automatiquement.*Vérifier l'état sur la boutique/);
    expect(failureMessage("WOOCOMMERCE", "uncertain", "read")).toMatch(/Rien n'a été envoyé/);
  });
});

describe("journal → outbound state", () => {
  const link = { provider: "SHOPIFY" as const, externalId: "gid://shopify/Product/1" };
  const now = new Date("2026-10-15T12:00:00Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);
  const ev = (action: string, msAgo: number, meta: Record<string, unknown> = {}) => ({
    action: `product.remote_listing_${action}`,
    createdAt: at(msAgo),
    metadata: { provider: "SHOPIFY", externalId: link.externalId, ...meta },
  });

  it("no journal: idle, unknown listing", () => {
    expect(deriveListingState([], link, now)).toEqual({ phase: "idle", listing: null, op: null, since: null, lastFailure: null });
  });
  it("a fresh request is in progress; one left without outcome becomes « à vérifier » (never retried)", () => {
    expect(deriveListingState([ev("requested", 1000, { op: "withdraw" })], link, now)).toMatchObject({ phase: "in_progress", op: "withdraw" });
    expect(deriveListingState([ev("requested", IN_FLIGHT_MS + 1, { op: "withdraw" })], link, now)).toMatchObject({ phase: "uncertain", op: "withdraw" });
  });
  it("uncertain outcome stays pending until a re-read is recorded", () => {
    const journal = [ev("changed", 9000, { op: "republish", remoteListing: "live" }), ev("requested", 5000, { op: "withdraw" }), ev("uncertain", 4000, { op: "withdraw" })];
    expect(deriveListingState(journal, link, now)).toMatchObject({ phase: "uncertain", op: "withdraw", listing: "live" });
    const reconciled = [...journal, ev("reconciled", 1000, { op: "withdraw", remoteListing: "withdrawn", applied: true })];
    expect(deriveListingState(reconciled, link, now)).toMatchObject({ phase: "idle", listing: "withdrawn" });
  });
  it("a definite failure leaves the last confirmed listing and is reported", () => {
    const journal = [ev("changed", 9000, { op: "withdraw", remoteListing: "withdrawn" }), ev("requested", 2000, { op: "republish" }), ev("failed", 1000, { op: "republish", failure: "denied" })];
    expect(deriveListingState(journal, link, now)).toMatchObject({ phase: "idle", listing: "withdrawn", lastFailure: "denied" });
  });
  it("only this store's events for this remote id count (a product linked to both stores, or re-published under a new id)", () => {
    const woo = { action: "product.remote_listing_requested", createdAt: at(1000), metadata: { provider: "WOOCOMMERCE", externalId: link.externalId, op: "withdraw" } };
    const otherId = { action: "product.remote_listing_uncertain", createdAt: at(1000), metadata: { provider: "SHOPIFY", externalId: "gid://shopify/Product/2", op: "withdraw" } };
    expect(deriveListingState([woo, otherId], link, now).phase).toBe("idle");
  });
  it("events in any order: the latest decides", () => {
    const journal = [ev("uncertain", 4000, { op: "withdraw" }), ev("changed", 1000, { op: "withdraw", remoteListing: "withdrawn" }), ev("requested", 5000, { op: "withdraw" })];
    expect(deriveListingState(journal, link, now)).toMatchObject({ phase: "idle", listing: "withdrawn" });
  });
});

describe("which archive the store may lift", () => {
  it("only this store's own integration archive (deleted or archived upstream)", () => {
    expect(isRestorableArchiveEvent({ actorType: "INTEGRATION", metadata: { source: "SHOPIFY", reason: "deleted_upstream" } }, "SHOPIFY")).toBe(true);
    expect(isRestorableArchiveEvent({ actorType: "INTEGRATION", metadata: { source: "SHOPIFY", reason: "archived_upstream" } }, "SHOPIFY")).toBe(true);
    expect(isRestorableArchiveEvent({ actorType: "INTEGRATION", metadata: { source: "WOOCOMMERCE", reason: "deleted_upstream" } }, "WOOCOMMERCE")).toBe(true);
  });
  it("a manual archive, another store's archive, an unknown reason or no event — never", () => {
    expect(isRestorableArchiveEvent({ actorType: "USER", metadata: { source: "SHOPIFY", reason: "deleted_upstream" } }, "SHOPIFY")).toBe(false);
    expect(isRestorableArchiveEvent({ actorType: "USER", metadata: null }, "SHOPIFY")).toBe(false);
    expect(isRestorableArchiveEvent({ actorType: "INTEGRATION", metadata: { source: "WOOCOMMERCE", reason: "deleted_upstream" } }, "SHOPIFY")).toBe(false);
    expect(isRestorableArchiveEvent({ actorType: "INTEGRATION", metadata: { source: "SHOPIFY", reason: "manual_cleanup" } }, "SHOPIFY")).toBe(false);
    expect(isRestorableArchiveEvent(null, "SHOPIFY")).toBe(false);
  });
});

describe("labels", () => {
  it("a Shopify gid is shown by its numeric id", () => {
    expect(remoteIdLabel("SHOPIFY", "gid://shopify/Product/123")).toBe("#123");
    expect(remoteIdLabel("WOOCOMMERCE", "501")).toBe("#501");
  });
  it("never claims a permanent deletion: both stores only get a soft, reversible withdrawal", () => {
    expect(REMOTE_OPERATION_SUPPORT.WOOCOMMERCE.withdraw).toMatchObject({ remoteStatus: "draft", reversible: true });
    expect(REMOTE_OPERATION_SUPPORT.SHOPIFY.withdraw).toMatchObject({ remoteStatus: "ARCHIVED", reversible: true });
    expect(REMOTE_OPERATION_SUPPORT.SHOPIFY.permanentDeletion).toMatch(/Jamais envoyée/);
    expect(REMOTE_OPERATION_SUPPORT.WOOCOMMERCE.permanentDeletion).toMatch(/Jamais envoyée/);
  });
});
