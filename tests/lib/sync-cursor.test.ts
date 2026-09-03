import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveOrdersSyncSince } from "@/lib/integrations/shared/sync-cursor";
import { resetDb } from "../helpers/db";

/**
 * The orders-import `since` bound must be derived from whether we hold any
 * order from the source, not from a sync-run timestamp — otherwise a first
 * sync that imported 0 (store's newest order predates the run) leaves the
 * cursor stuck at "now" and every later sync also imports 0. Reproduced
 * live against a real WooCommerce store with 298 orders.
 */
async function seedOrder(source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY", externalId: string) {
  const customer = await prisma.customer.create({ data: { fullName: "C" } });
  await prisma.order.create({
    data: { customerId: customer.id, source, externalId, subtotal: 1, total: 1, currency: "MAD" },
  });
}

describe("resolveOrdersSyncSince", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("is unbounded (undefined) on a first sync, even after a prior sync run imported nothing", async () => {
    const integration = await prisma.integration.create({ data: { provider: "WOOCOMMERCE" } });
    await prisma.syncRun.create({
      data: {
        integrationId: integration.id,
        resource: "COMMANDES",
        direction: "IMPORT",
        status: "SUCCES",
        itemsImported: 0,
      },
    });
    expect(await resolveOrdersSyncSince("WOOCOMMERCE")).toBeUndefined();
  });

  it("returns a rolling window once an order from that source exists", async () => {
    await seedOrder("WOOCOMMERCE", "wc-1");
    const since = await resolveOrdersSyncSince("WOOCOMMERCE");
    expect(since).toBeInstanceOf(Date);
    const daysAgo = (Date.now() - (since as Date).getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(300);
  });

  it("is scoped per source — a WooCommerce order does not bound a Shopify sync", async () => {
    await seedOrder("WOOCOMMERCE", "wc-1");
    expect(await resolveOrdersSyncSince("SHOPIFY")).toBeUndefined();
  });
});
