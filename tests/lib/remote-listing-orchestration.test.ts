import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * « Retirer de la boutique » / « Remettre en vente » end to end, with the
 * database and both store clients mocked in memory (no Prisma connection,
 * no network): read-first, one attempt, « à vérifier » on an uncertain
 * outcome, no duplicate state-changing call on a retry, reconciliation by
 * re-reading. The DB-backed counterpart is
 * tests/integration/remote-product-lifecycle.test.ts.
 */

type JournalRow = { entityId: string; action: string; metadata: Record<string, unknown>; createdAt: Date; actorUserId?: string };
const journal: JournalRow[] = [];
let clock = Date.parse("2026-10-15T10:00:00Z");

vi.mock("@/lib/prisma", () => {
  const findMany = async ({ where }: { where: { entityId: string; action: { in: string[] } } }) =>
    journal
      .filter((e) => e.entityId === where.entityId && where.action.in.includes(e.action))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((e) => ({ action: e.action, metadata: e.metadata, createdAt: e.createdAt }));
  const tx = { $queryRaw: async () => [], auditEvent: { findMany } };
  return { prisma: { auditEvent: { findMany }, $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }, prismaBase: {} };
});
vi.mock("@/lib/audit", () => ({
  recordAuditEvent: async (input: { entityId: string; action: string; metadata: Record<string, unknown>; actorUserId?: string }) => {
    clock += 1000;
    journal.push({ entityId: input.entityId, action: input.action, metadata: input.metadata, createdAt: new Date(clock), actorUserId: input.actorUserId });
  },
}));
vi.mock("@/lib/notifications", () => ({ notify: async () => undefined, resolveNotifications: async () => undefined }));
vi.mock("@/lib/integrations/woocommerce/client-loader", () => ({ loadWooCommerceClient: async () => null }));
vi.mock("@/lib/integrations/shopify/client-loader", () => ({ loadShopifyClient: async () => null }));

const { changeRemoteListing, reconcileRemoteListing, remoteListingStateOf, shopifyListingAdapter, wooListingAdapter } = await import("@/lib/integrations/shared/remote-listing");
const { IN_FLIGHT_MS } = await import("@/lib/integrations/shared/remote-listing-state");
const wooErrors = await import("@/lib/integrations/woocommerce/errors");
const shopifyErrors = await import("@/lib/integrations/shopify/errors");

type Failure = "denied" | "rate_limited" | "timeout" | "network" | "server" | "malformed" | "rejected";
interface FakeShop {
  status: string | null; // null = deleted
  writes: string[];
  readFailure: Failure | null;
  writeFailure: { kind: Failure; afterApply: boolean } | null;
}

function wooError(kind: Failure): Error {
  if (kind === "denied") return new wooErrors.WooCommercePermissionError("x");
  if (kind === "rate_limited") return new wooErrors.WooCommerceRateLimitError("x");
  if (kind === "timeout") return new wooErrors.WooCommerceTimeoutError("x");
  if (kind === "malformed") return new wooErrors.WooCommerceMalformedResponseError("x");
  if (kind === "rejected") return new wooErrors.WooCommerceApiError("x", 400, "rest_invalid_param", undefined);
  return new wooErrors.WooCommerceUnavailableError("x");
}
function shopifyError(kind: Failure): Error {
  if (kind === "denied") return new shopifyErrors.ShopifyPermissionError("x");
  if (kind === "rate_limited") return new shopifyErrors.ShopifyThrottledError("x");
  if (kind === "timeout") return new shopifyErrors.ShopifyTimeoutError("x");
  if (kind === "malformed") return new shopifyErrors.ShopifyMalformedResponseError("x");
  if (kind === "rejected") return new shopifyErrors.ShopifyUserError("x");
  return new shopifyErrors.ShopifyUnavailableError("x");
}

const PLATFORMS = [
  {
    provider: "WOOCOMMERCE" as const,
    externalId: "501",
    live: "publish",
    withdrawn: "draft",
    adapter: (shop: FakeShop) =>
      wooListingAdapter({
        async getProduct() {
          if (shop.readFailure) throw wooError(shop.readFailure);
          if (shop.status === null) throw new wooErrors.WooCommerceNotFoundError("x", "woocommerce_rest_product_invalid_id");
          return { status: shop.status };
        },
        async setProductStatus(_id, status) {
          const failure = shop.writeFailure;
          shop.writeFailure = null;
          if (failure?.afterApply || !failure) {
            shop.writes.push(status);
            shop.status = status;
          }
          if (failure) throw wooError(failure.kind);
          return { status };
        },
      }),
  },
  {
    provider: "SHOPIFY" as const,
    externalId: "gid://shopify/Product/9001",
    live: "ACTIVE",
    withdrawn: "ARCHIVED",
    adapter: (shop: FakeShop) =>
      shopifyListingAdapter({
        async getProductStatus() {
          if (shop.readFailure) throw shopifyError(shop.readFailure);
          return shop.status === null ? null : { status: shop.status };
        },
        async setProductStatus(_gid, status) {
          const failure = shop.writeFailure;
          shop.writeFailure = null;
          if (failure?.afterApply || !failure) {
            shop.writes.push(status);
            shop.status = status;
          }
          if (failure) throw shopifyError(failure.kind);
          return { status };
        },
      }),
  },
];

beforeEach(() => {
  journal.length = 0;
  clock = Date.parse("2026-10-15T10:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(clock));
});

describe.each(PLATFORMS)("$provider", (platform) => {
  const USER = "user-1";
  const link = { provider: platform.provider, productId: `p-${platform.provider}`, productName: "Tee", externalId: platform.externalId, kind: "publication" as const };
  const shopOf = (status: string | null): FakeShop => ({ status, writes: [], readFailure: null, writeFailure: null });
  const actions = () => journal.filter((e) => e.entityId === link.productId).map((e) => e.action.replace("product.remote_listing_", ""));
  const state = () => remoteListingStateOf(link);

  it("success: read first, one soft status change, confirmed", async () => {
    const shop = shopOf(platform.live);
    expect(await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop))).toEqual({ ok: true, outcome: "changed", listing: "withdrawn" });
    expect(shop.writes).toEqual([platform.withdrawn]);
    expect(actions()).toEqual(["requested", "changed"]);
    expect(journal.every((e) => e.actorUserId === USER)).toBe(true);
    expect(await state()).toMatchObject({ phase: "idle", listing: "withdrawn" });

    expect(await changeRemoteListing(link, "republish", USER, platform.adapter(shop))).toMatchObject({ ok: true, outcome: "changed", listing: "live" });
    expect(shop.writes).toEqual([platform.withdrawn, platform.live]);
  });

  it("already in the target state: nothing sent; a repeated click records nothing new", async () => {
    const shop = shopOf(platform.withdrawn);
    expect(await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop))).toMatchObject({ ok: true, outcome: "already" });
    expect(await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop))).toMatchObject({ ok: true, outcome: "already" });
    expect(shop.writes).toEqual([]);
    expect(actions()).toEqual(["changed"]);
  });

  it("already deleted on the store: nothing sent, the user is sent to the deletion check", async () => {
    const shop = shopOf(null);
    const result = await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop));
    expect(result).toMatchObject({ ok: false, outcome: "missing", message: expect.stringContaining("Vérifier sur la boutique") });
    expect(shop.writes).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it.each([
    ["denied", /Accès refusé/],
    ["rate_limited", /limite temporairement/],
    ["rejected", /a refusé la demande/],
  ] as const)("%s: visible error, nothing applied, listing unchanged", async (kind, message) => {
    const shop = shopOf(platform.live);
    shop.writeFailure = { kind, afterApply: false };
    const result = await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop));
    expect(result).toMatchObject({ ok: false, outcome: "failed", failure: kind, message: expect.stringMatching(message) });
    expect(shop.status).toBe(platform.live);
    expect(actions()).toEqual(["requested", "failed"]);
    expect(await state()).toMatchObject({ phase: "idle", lastFailure: kind });
  });

  it("the store cannot even be read: nothing sent, nothing recorded", async () => {
    const shop = shopOf(platform.live);
    shop.readFailure = "denied";
    expect(await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop))).toMatchObject({ ok: false, outcome: "read_failed", failure: "denied" });
    shop.readFailure = "timeout";
    expect(await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop))).toMatchObject({ ok: false, outcome: "read_failed" });
    expect(shop.writes).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it.each(["timeout", "network", "server", "malformed"] as const)(
    "%s AFTER the store applied it: « à vérifier »; the retry re-reads and sends NOTHING again",
    async (kind) => {
      const shop = shopOf(platform.live);
      shop.writeFailure = { kind, afterApply: true };
      const first = await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop));
      expect(first).toMatchObject({ ok: false, outcome: "uncertain", message: expect.stringContaining("Résultat incertain") });
      expect(await state()).toMatchObject({ phase: "uncertain", op: "withdraw" });

      const retry = await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop));
      expect(retry).toMatchObject({ ok: true, outcome: "already", listing: "withdrawn" });
      expect(shop.writes).toEqual([platform.withdrawn]); // exactly one state-changing call overall
      expect(await state()).toMatchObject({ phase: "idle", listing: "withdrawn" });
    }
  );

  it("timeout BEFORE the store applied it: reconciliation re-reads and records that it did not happen", async () => {
    const shop = shopOf(platform.live);
    shop.writeFailure = { kind: "timeout", afterApply: false };
    await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop));
    expect(await reconcileRemoteListing(link, USER, platform.adapter(shop))).toEqual({ ok: true, listing: "live", resolved: true });
    const reconciled = journal.find((e) => e.action === "product.remote_listing_reconciled");
    expect(reconciled?.metadata).toMatchObject({ op: "withdraw", remoteListing: "live", applied: false });
    expect(await state()).toMatchObject({ phase: "idle", listing: "live" });
    expect(shop.writes).toEqual([]);
  });

  it("reconciliation that cannot read keeps « à vérifier »", async () => {
    const shop = shopOf(platform.live);
    shop.writeFailure = { kind: "network", afterApply: false };
    await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop));
    shop.readFailure = "server";
    expect(await reconcileRemoteListing(link, USER, platform.adapter(shop))).toMatchObject({ ok: false, outcome: "read_failed" });
    expect(await state()).toMatchObject({ phase: "uncertain" });
  });

  it("a request still in flight blocks a second one (double click, second tab)", async () => {
    const shop = shopOf(platform.live);
    journal.push({ entityId: link.productId, action: "product.remote_listing_requested", metadata: { provider: link.provider, externalId: link.externalId, op: "withdraw" }, createdAt: new Date(clock) });
    expect(await changeRemoteListing(link, "withdraw", USER, platform.adapter(shop))).toMatchObject({ ok: false, outcome: "busy" });
    expect(await reconcileRemoteListing(link, USER, platform.adapter(shop))).toMatchObject({ ok: false, outcome: "busy" });
    expect(shop.writes).toEqual([]);
  });

  it("a request that never got an outcome (crash) becomes « à vérifier », then reconciles", async () => {
    const shop = shopOf(platform.withdrawn); // it did reach the store
    journal.push({ entityId: link.productId, action: "product.remote_listing_requested", metadata: { provider: link.provider, externalId: link.externalId, op: "withdraw" }, createdAt: new Date(clock) });
    vi.setSystemTime(new Date(clock + IN_FLIGHT_MS + 1));
    clock += IN_FLIGHT_MS + 1;
    expect(await state()).toMatchObject({ phase: "uncertain" });
    expect(await reconcileRemoteListing(link, USER, platform.adapter(shop))).toEqual({ ok: true, listing: "withdrawn", resolved: true });
    expect(shop.writes).toEqual([]);
  });
});

it("a product linked to both stores keeps one independent state per store", async () => {
  const productId = "p-both";
  const wooLink = { provider: "WOOCOMMERCE" as const, productId, productName: "Tee", externalId: "77", kind: "publication" as const };
  const shopLink = { provider: "SHOPIFY" as const, productId, productName: "Tee", externalId: "gid://shopify/Product/77", kind: "publication" as const };
  const wooShop: FakeShop = { status: "publish", writes: [], readFailure: null, writeFailure: { kind: "timeout", afterApply: false } };
  await changeRemoteListing(wooLink, "withdraw", "u", PLATFORMS[0].adapter(wooShop));
  expect(await remoteListingStateOf(wooLink)).toMatchObject({ phase: "uncertain" });
  expect(await remoteListingStateOf(shopLink)).toMatchObject({ phase: "idle", listing: null });
});
